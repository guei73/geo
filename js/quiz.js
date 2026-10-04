/*
 * Движок теста: без DOM, чтобы его можно было проверять в Node.
 *
 * Сессия = упорядоченный список вопросов + журнал ответов.
 *   mode:   'map'      — «Где находится …?» (клик по стране на карте)
 *           'capitals' — «Столица …?» (4 варианта ответа)
 *           'combo'    — сначала страна на карте, затем её столица:
 *                        у каждого вопроса два этапа (part 'place' и 'capital')
 *   variant (только для 'capitals'):
 *           'choice'   — выбор из 4 вариантов (part 'capital')
 *           'input'    — ввод столицы с клавиатуры (part 'input')
 *           'reverse'  — «Чья это столица?»: клик по стране на карте (part 'reverse')
 *   region: 'all' | 'europe' | 'asia' | 'oceania' | часть Азии ('asia-near', 'asia-central', …)
 */
(function (root) {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rng) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* exclude — ISO стран, которые пользователь отметил как известные. */
  function poolFor(countries, region, isoFilter, exclude) {
    return countries.filter(function (c) {
      if (isoFilter && isoFilter.indexOf(c.iso) === -1) return false;
      if (exclude && exclude.indexOf(c.iso) !== -1) return false;
      return region === 'all' || c.region === region || c.sub === region;
    });
  }

  /*
   * Три неверных варианта: сначала столицы соседних стран (та же часть Азии,
   * затем тот же регион) — так сложнее и полезнее; при нехватке — из всего
   * списка. Столицы не повторяются.
   */
  function capitalOptions(country, allCountries, rng) {
    var taken = {};
    taken[country.capital] = true;
    var others = allCountries.filter(function (c) { return c.iso !== country.iso; });
    var sameSub = country.sub ? shuffle(others.filter(function (c) { return c.sub === country.sub; }), rng) : [];
    var sameRegion = shuffle(others.filter(function (c) {
      return c.region === country.region && (!country.sub || c.sub !== country.sub);
    }), rng);
    var rest = shuffle(others.filter(function (c) { return c.region !== country.region; }), rng);
    var wrong = [];
    var candidates = sameSub.concat(sameRegion, rest);
    for (var i = 0; i < candidates.length && wrong.length < 3; i++) {
      var cap = candidates[i].capital;
      if (taken[cap]) continue;
      taken[cap] = true;
      wrong.push(cap);
    }
    return shuffle([country.capital].concat(wrong), rng);
  }

  function createSession(opts) {
    var countries = opts.countries;
    var rng = opts.rng || (opts.seed != null ? mulberry32(opts.seed) : Math.random);
    var pool = poolFor(countries, opts.region || 'all', opts.isoFilter || null, opts.exclude || null);
    if (!pool.length) throw new Error('Пустой набор вопросов');
    var questions = shuffle(pool, rng).map(function (c) {
      var q = { country: c };
      if (opts.mode === 'capitals' || opts.mode === 'combo') q.options = capitalOptions(c, countries, rng);
      return q;
    });
    return {
      mode: opts.mode,
      variant: opts.mode === 'capitals' ? (opts.variant || 'choice') : null,
      region: opts.region || 'all',
      isoFilter: opts.isoFilter || null,
      questions: questions,
      index: 0,
      stage: opts.mode === 'combo' ? 'place' : null,
      answers: [],
      streak: 0,
      bestStreak: 0,
      score: 0,
      startedAt: opts.now != null ? opts.now : Date.now(),
      finishedAt: null
    };
  }

  function current(session) {
    return session.questions[session.index] || null;
  }

  /* Что сейчас спрашивается: 'place' | 'capital' | 'input' | 'reverse'. */
  function part(session) {
    if (session.mode === 'map') return 'place';
    if (session.mode === 'capitals') {
      if (session.variant === 'input') return 'input';
      if (session.variant === 'reverse') return 'reverse';
      return 'capital';
    }
    return session.stage;
  }

  /* Ответ — страна на карте (ISO), а не название столицы. */
  function isMapPart(p) {
    return p === 'place' || p === 'reverse';
  }

  // --- Проверка введённой столицы ---------------------------------------

  /* Регистр, «ё», пробелы, дефисы и точки не важны. */
  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[\s\-‐–—.,'’"«»]+/g, '');
  }

  function levenshtein(a, b) {
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  /*
   * { ok, typo }: одна опечатка допускается в названиях от 5 букв,
   * две — от 10 букв. Тогда ответ засчитывается, но с пометкой об опечатке.
   */
  function matchCapital(given, capital) {
    var a = normalize(given), b = normalize(capital);
    if (!a) return { ok: false, typo: false };
    if (a === b) return { ok: true, typo: false };
    var allowed = b.length >= 10 ? 2 : b.length >= 5 ? 1 : 0;
    var d = levenshtein(a, b);
    return { ok: d <= allowed, typo: d <= allowed };
  }

  /* Сколько ответов всего даётся за тест. */
  function answersPerQuestion(mode) {
    return mode === 'combo' ? 2 : 1;
  }

  /*
   * given: ISO выбранной страны (режим 'map'), строка-столица ('capitals')
   * или null, если пользователь нажал «Не знаю».
   */
  function answer(session, given) {
    var q = current(session);
    if (!q) throw new Error('Тест уже завершён');
    var c = q.country;
    var p = part(session);
    var ok, typo = false;
    if (isMapPart(p)) ok = given === c.iso;
    else if (p === 'input') {
      var m = matchCapital(given, c.capital);
      ok = m.ok;
      typo = m.typo;
    } else ok = given === c.capital;
    var record = { country: c, given: given, correct: ok, part: p, typo: typo };
    session.answers.push(record);
    if (session.mode === 'combo') session.stage = p === 'place' ? 'capital' : 'done';
    if (ok) {
      session.score++;
      session.streak++;
      if (session.streak > session.bestStreak) session.bestStreak = session.streak;
    } else {
      session.streak = 0;
    }
    return record;
  }

  /* В режиме «Страны + столицы» после ответа о месте нужен ещё ответ о столице. */
  function awaitingCapital(session) {
    return session.mode === 'combo' && session.stage === 'capital';
  }

  function next(session, now) {
    session.index++;
    if (session.mode === 'combo') session.stage = 'place';
    if (session.index >= session.questions.length && !session.finishedAt) {
      session.finishedAt = now != null ? now : Date.now();
    }
    return current(session);
  }

  /*
   * Убрать текущий вопрос из теста (пользователь отметил столицу как известную).
   * Вопрос не засчитывается ни как верный, ни как ошибка.
   */
  function dropCurrent(session, now) {
    if (!current(session)) return null;
    session.questions.splice(session.index, 1);
    if (session.mode === 'combo') session.stage = 'place';
    if (session.index >= session.questions.length && !session.finishedAt) {
      session.finishedAt = now != null ? now : Date.now();
    }
    return current(session);
  }

  function isFinished(session) {
    return session.index >= session.questions.length;
  }

  function summary(session) {
    var total = session.questions.length * answersPerQuestion(session.mode);
    var end = session.finishedAt || Date.now();
    return {
      total: total,
      score: session.score,
      percent: total ? Math.round((session.score / total) * 100) : 0,
      bestStreak: session.bestStreak,
      timeMs: Math.max(0, end - session.startedAt),
      mistakes: session.answers.filter(function (a) { return !a.correct; })
    };
  }

  /* Вопрос в правильной грамматической форме. */
  function questionParts(mode, c, p) {
    if (p === 'reverse') return { before: '', subject: c.capital, after: ' — столица какой страны?' };
    if (p ? (p === 'capital' || p === 'input') : mode === 'capitals') return { before: 'Столица ', subject: c.gen, after: '?' };
    return { before: c.plural ? 'Где находятся ' : 'Где находится ', subject: c.name, after: '?' };
  }

  var api = {
    mulberry32: mulberry32,
    shuffle: shuffle,
    poolFor: poolFor,
    capitalOptions: capitalOptions,
    createSession: createSession,
    current: current,
    part: part,
    isMapPart: isMapPart,
    normalize: normalize,
    levenshtein: levenshtein,
    matchCapital: matchCapital,
    dropCurrent: dropCurrent,
    answersPerQuestion: answersPerQuestion,
    awaitingCapital: awaitingCapital,
    answer: answer,
    next: next,
    isFinished: isFinished,
    summary: summary,
    questionParts: questionParts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Quiz = api;
})(typeof window !== 'undefined' ? window : this);
