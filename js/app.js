/*
 * Контроллер интерфейса: экраны (меню → игра → результат, атлас),
 * связь движка теста, карты и статистики.
 *
 * Этапы вопроса (атрибут data-stage у #app):
 *   place   — ждём клик по стране на карте;
 *   review  — ответ о стране дан, показываем разбор;
 *   capital — показаны 4 варианта столицы (и разбор после ответа).
 */
(function () {
  'use strict';

  var COUNTRIES = window.GEO_DATA.COUNTRIES;
  var REGIONS = window.GEO_DATA.REGIONS;
  var MODES = {
    map: { title: 'Страны', hint: 'Найдите страну на карте и нажмите на неё.' },
    capitals: { title: 'Столицы', hint: 'Карта показывает страну — назовите её столицу.' },
    combo: { title: 'Страны + столицы', hint: 'Сначала найдите страну на карте, затем выберите её столицу.' }
  };
  var VARIANTS = {
    input: { title: 'ввод', hint: 'Напечатайте столицу. Регистр и «ё» не важны, одна опечатка прощается.' },
    choice: { title: '4 варианта', hint: 'Выберите столицу из четырёх вариантов (клавиши 1–4).' },
    reverse: { title: 'чья столица', hint: 'Показывается столица — нажмите на её страну на карте.' }
  };
  var HL_HINTS = {
    on: 'Ответы закрашиваются на карте, правильная страна показывается.',
    off: 'Карта не подсказывает: верно или нет — только в тексте.'
  };
  var DELAY_OK = 1200;
  var DELAY_BAD = 2800;

  var byIso = {};
  COUNTRIES.forEach(function (c) { byIso[c.iso] = c; });

  function $(id) { return document.getElementById(id); }
  var app = $('app');

  var saved = Storage.load();
  var state = {
    screen: 'menu',
    mode: MODES[saved.settings.mode] ? saved.settings.mode : 'map',
    region: REGIONS[saved.settings.region] ? saved.settings.region : 'all',
    highlight: saved.settings.highlight !== false,
    variant: VARIANTS[saved.settings.capVariant] ? saved.settings.capVariant : 'choice',
    session: null,
    practice: false,
    lastStart: null,
    locked: false,       // ответ дан, ждём перехода к следующему вопросу
    paused: false,
    pausedAt: 0,
    next: null,          // { timer, due, left } — автопереход
    savedView: null,
    userMoved: false,
    clock: null
  };

  var map = new MapView($('map'), window.MAP_DATA, {
    onCountryClick: onCountryClick,
    onHover: onHover,
    onInteract: function () { state.userMoved = true; }
  });

  // ---------------------------------------------------------------------
  // Вспомогательное

  function regionIsos(region) {
    return COUNTRIES.filter(function (c) { return window.GEO_DATA.inRegion(c, region); })
      .map(function (c) { return c.iso; });
  }

  function regionBox(region) {
    var isos = regionIsos(region);
    // Европу кадрируем без азиатской части России.
    if (region === 'europe') isos = isos.filter(function (i) { return i !== '643'; });
    return map.boxOf(isos);
  }

  /* Рамка вокруг страны с соседями. */
  function contextBox(iso) {
    var b = window.MAP_DATA.countries[iso].box;
    var size = Math.max(b[2] - b[0], b[3] - b[1]);
    var pad = Math.max(size * 0.45, 80);
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function formatTime(ms) {
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function setSeg(container, value) {
    Array.prototype.forEach.call(container.querySelectorAll('[role="radio"]'), function (b) {
      b.setAttribute('aria-checked', String(b.dataset.value === value));
    });
  }

  // ---------------------------------------------------------------------
  // Звук

  var audio = null;
  function tone(freqs, type, dur) {
    if (!Storage.load().settings.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var t = audio.currentTime;
      freqs.forEach(function (f, i) {
        var o = audio.createOscillator();
        var g = audio.createGain();
        o.type = type;
        o.frequency.value = f;
        var start = t + i * dur * 0.8;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(0.1, start + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g).connect(audio.destination);
        o.start(start);
        o.stop(start + dur + 0.02);
      });
    } catch (e) { /* звук недоступен */ }
  }
  var sfx = {
    ok: function () { tone([660, 990], 'sine', 0.12); },
    bad: function () { tone([240, 180], 'triangle', 0.15); },
    done: function () { tone([523, 659, 784], 'sine', 0.13); }
  };

  // ---------------------------------------------------------------------
  // Экраны и область карты

  function setScreen(name) {
    state.screen = name;
    app.dataset.screen = name;
    hideTooltip();
    updateInsets();
  }

  function setStage(stage) {
    app.dataset.stage = stage || '';
  }

  function updateInsets() {
    var w = window.innerWidth, h = window.innerHeight;
    // Панель меню сбоку: на компьютере и на телефоне, повёрнутом горизонтально.
    var desktop = w > 860 || (h <= 500 && w > h);
    var ins = { top: 12, bottom: 12, left: 12, right: 12 };
    if (state.screen === 'menu' || state.screen === 'result') {
      var panel = state.screen === 'menu' ? $('menu') : $('result');
      if (desktop) ins.left = panel.offsetWidth + 12;
      else ins.bottom = Math.min(h * 0.86, panel.scrollHeight) + 8;
    } else {
      ins.top = $('hud').getBoundingClientRect().bottom + 10;
      var stage = app.dataset.stage;
      if (stage === 'capital' || stage === 'input') {
        var bar = stage === 'capital' ? $('options') : $('answer-form');
        ins.bottom = h - bar.getBoundingClientRect().top + 12;
      } else {
        ins.bottom = 70;
      }
      if (desktop) { ins.right = 64; ins.left = 24; }
    }
    if (h - ins.top - ins.bottom < 140) ins.bottom = Math.max(12, h - ins.top - 140);
    map.setInsets(ins);
  }

  function fitRegion(region, animate) {
    map.fitBox(regionBox(region), { padding: 16, animate: animate !== false, allowCrop: 2 });
  }

  function applyHighlightSetting() {
    app.dataset.highlight = state.highlight ? 'on' : 'off';
  }

  // ---------------------------------------------------------------------
  // Меню

  function renderMenu() {
    var s = Storage.load();
    setSeg($('mode-seg'), state.mode);
    $('mode-hint').textContent = MODES[state.mode].hint;
    setSeg($('variant-seg'), state.variant);
    $('variant-hint').textContent = VARIANTS[state.variant].hint;
    setSeg($('hl-seg'), state.highlight ? 'on' : 'off');
    $('hl-hint').textContent = HL_HINTS[state.highlight ? 'on' : 'off'];

    var seg = $('region-seg');
    seg.innerHTML = '';
    ['all', 'europe', 'asia', 'oceania'].forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = r;
      b.innerHTML = esc(r === 'oceania' ? 'Австралия и Океания' : REGIONS[r].title) + '<small>' + regionIsos(r).length + '</small>';
      seg.appendChild(b);
    });
    var top = REGIONS[state.region].parent || state.region;
    setSeg(seg, top);

    // Части Азии — видны, когда выбрана Азия.
    var sub = $('asia-seg');
    sub.hidden = top !== 'asia';
    if (!sub.hidden) {
      sub.innerHTML = '';
      [{ key: 'asia', title: 'Вся Азия' }].concat(window.GEO_DATA.ASIA_GROUPS).forEach(function (g) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.value = g.key;
        b.innerHTML = esc(g.title) + '<small>' + regionIsos(g.key).length + '</small>';
        sub.appendChild(b);
      });
      setSeg(sub, state.region);
    }

    var all = regionIsos(state.region).length;
    var n = startPool().length;
    var skipped = all - n;
    $('start-hint').textContent = '· ' + n + ' ' + plural(n, 'страна', 'страны', 'стран') +
      (skipped ? ' (' + skipped + ' ' + plural(skipped, 'известна', 'известны', 'известны') + ')' : '');
    $('btn-start').disabled = n === 0;

    var known = Storage.knownList().length;
    $('btn-known-list').innerHTML = '<span>Известные столицы</span>' +
      (known ? '<span class="count count-ok">' + known + '</span>' : '');

    var lm = s.lastMistakes;
    var bm = $('btn-mistakes');
    bm.hidden = !(lm && lm.isos && lm.isos.length);
    if (!bm.hidden) {
      bm.innerHTML = '<span>Работа над ошибками · ' + esc(modeTitle(lm.mode, lm.variant)) +
        '</span><span class="count">' + lm.isos.length + '</span>';
    }

    var weak = Storage.weakest(state.mode, 10);
    var bw = $('btn-weak');
    bw.hidden = !weak.length;
    if (weak.length) bw.innerHTML = '<span>Слабые места</span><span class="count">' + weak.length + '</span>';

    var best = s.best[Storage.bestKey(state.mode, state.variant, state.region)];
    var acc = s.answered ? Math.round((s.correct / s.answered) * 100) + '%' : '—';
    $('stats').innerHTML =
      '<dt>Рекорд (' + esc(modeTitle(state.mode, state.variant).toLowerCase()) + ', ' + esc(REGIONS[state.region].title.toLowerCase()) + ')</dt>' +
      '<dd>' + (best ? best.score + ' из ' + best.total + ' · ' + formatTime(best.timeMs) : '—') + '</dd>' +
      '<dt>Пройдено тестов</dt><dd>' + s.games + '</dd>' +
      '<dt>Точность за всё время</dt><dd>' + acc + '</dd>';

    var wl = $('weak-line');
    wl.hidden = !weak.length;
    if (weak.length) {
      wl.innerHTML = 'Чаще всего ошибки: ' + weak.slice(0, 6).map(function (w) {
        return '<b>' + esc(byIso[w.iso].name) + '</b>';
      }).join(', ');
    }
    $('sound-toggle').checked = !!s.settings.sound;
  }

  function modeTitle(mode, variant) {
    var t = MODES[mode] ? MODES[mode].title : '';
    if (mode === 'capitals' && VARIANTS[variant]) t += ' (' + VARIANTS[variant].title + ')';
    return t;
  }

  /* Известные столицы не спрашиваются только в режиме «Столицы». */
  function excludedFor(mode) {
    return mode === 'capitals' ? Storage.knownList() : [];
  }

  function startPool() {
    return Quiz.poolFor(COUNTRIES, state.region, null, excludedFor(state.mode));
  }

  function showMenu() {
    stopGame();
    $('pause').hidden = true;
    $('confirm').hidden = true;
    map.resetStates();
    map.clearClass('is-focus');
    map.setActive(regionIsos(state.region));
    app.dataset.mode = state.mode;
    setStage('');
    renderMenu();
    setScreen('menu');
    fitRegion(state.region);
  }

  // ---------------------------------------------------------------------
  // Игра

  function startGame(opts) {
    stopGame();
    state.lastStart = opts;
    state.mode = opts.mode;
    state.practice = !!opts.isoFilter;
    var exclude = excludedFor(opts.mode);
    if (!Quiz.poolFor(COUNTRIES, opts.region, opts.isoFilter || null, exclude).length) {
      toast('Все столицы этого набора отмечены как известные');
      return;
    }
    state.session = Quiz.createSession({
      countries: COUNTRIES,
      mode: opts.mode,
      variant: opts.variant,
      region: opts.region,
      isoFilter: opts.isoFilter || null,
      exclude: exclude
    });
    state.locked = false;
    state.paused = false;
    state.savedView = null;

    map.resetStates();
    map.clearClass('is-focus');
    map.setActive(regionIsos(opts.region));
    app.dataset.mode = opts.mode;
    applyHighlightSetting();

    var strip = $('progress-strip');
    strip.innerHTML = '';
    for (var i = 0; i < state.session.questions.length; i++) strip.appendChild(document.createElement('i'));

    $('score').textContent = '0';
    $('streak').textContent = '0';
    $('streak-box').classList.remove('is-hot');
    $('q-total').textContent = state.session.questions.length;
    $('q-kicker').textContent = (state.practice ? 'Работа над ошибками · ' : '') +
      modeTitle(opts.mode, state.session.variant) + ' · ' + REGIONS[opts.region].title +
      (state.highlight ? '' : ' · без подсветки');

    setScreen('game');
    renderQuestion();
    requestAnimationFrame(function () {
      updateInsets();
      var p = Quiz.part(state.session);
      if (p === 'capital' || p === 'input') focusOnCountry(Quiz.current(state.session).country.iso);
      else map.fitBox(regionBox(opts.region), { padding: 12, allowCrop: 2 });
    });

    state.clock = setInterval(updateClock, 250);
    updateClock();
  }

  function stopGame() {
    clearNext();
    clearInterval(state.clock);
    state.clock = null;
    state.paused = false;
    app.classList.remove('is-paused');
  }

  function updateClock() {
    var s = state.session;
    if (!s) return;
    var now = state.paused ? state.pausedAt : (s.finishedAt || Date.now());
    $('timer').textContent = formatTime(now - s.startedAt);
  }

  function setQuestionText(part) {
    var s = state.session;
    var c = Quiz.current(s).country;
    var parts = Quiz.questionParts(s.mode, c, part);
    $('question').innerHTML = esc(parts.before) + '<b>' + esc(parts.subject) + '</b>' + esc(parts.after);
  }

  function renderOptions(q) {
    var opts = $('options');
    opts.innerHTML = '';
    q.options.forEach(function (cap, idx) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'option';
      b.dataset.value = cap;
      b.innerHTML = '<span class="key">' + (idx + 1) + '</span><span>' + esc(cap) + '</span>';
      opts.appendChild(b);
    });
  }

  function renderQuestion() {
    var s = state.session;
    var q = Quiz.current(s);
    var p = Quiz.part(s);
    setQuestionText(p);
    $('q-num').textContent = s.index + 1;
    $('question-card').classList.remove('state-ok', 'state-bad');
    $('feedback').className = 'feedback';
    $('btn-next').hidden = false;
    $('next-timer').className = 'next-timer';

    var segs = $('progress-strip').children;
    for (var i = 0; i < segs.length; i++) segs[i].classList.toggle('now', i === s.index);

    $('options').innerHTML = '';
    if (p === 'capital' || p === 'input') {
      map.addClass(q.country.iso, 'is-target');
      if (p === 'capital') {
        renderOptions(q);
        setStage('capital');
      } else {
        resetInput();
        setStage('input');
      }
      if (s.index > 0) focusOnCountry(q.country.iso);
    } else {
      setStage('place');
      $('btn-skip').disabled = false;
    }
    app.dataset.answered = 'no';
    state.locked = false;
    state.userMoved = false;
    requestAnimationFrame(updateInsets);
  }

  function resetInput() {
    var form = $('answer-form'), inp = $('answer-input');
    form.className = 'answer-form';
    inp.value = '';
    inp.disabled = false;
    $('btn-answer').disabled = false;
    $('btn-input-skip').disabled = false;
    // На телефоне не открываем клавиатуру сама по себе — она закрыла бы карту.
    if (window.matchMedia('(hover: hover)').matches) setTimeout(function () { inp.focus(); }, 30);
  }

  /* «Знаю»: столица известна — больше не спрашивать, вопрос убирается без оценки. */
  function markKnown() {
    var s = state.session;
    if (state.screen !== 'game' || s.mode !== 'capitals' || state.locked || state.paused) return;
    var c = Quiz.current(s).country;
    Storage.setKnown(c.iso, true);
    toast('✓ ' + c.name + ' — ' + c.capital + ': больше не спрашиваем');
    map.removeClass(c.iso, 'is-target');
    var seg = $('progress-strip').children[s.index];
    if (seg) seg.remove();
    Quiz.dropCurrent(s);
    $('q-total').textContent = s.questions.length;
    if (Quiz.isFinished(s)) {
      if (s.answers.length) finishGame();
      else showMenu();
      return;
    }
    renderQuestion();
    var np = Quiz.part(s);
    if (s.index === 0 && (np === 'capital' || np === 'input')) focusOnCountry(Quiz.current(s).country.iso);
  }

  var toastTimer = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 1800);
  }

  function focusOnCountry(iso) {
    updateInsets();
    map.fitBox(contextBox(iso), { padding: 20, duration: 650 });
  }

  function onCountryClick(iso) {
    if (state.screen === 'study' || state.screen === 'result') {
      if (byIso[iso]) focusCountry(iso, true);
      return;
    }
    if (state.screen !== 'game' || state.locked || state.paused) return;
    if (app.dataset.stage !== 'place' || !byIso[iso]) return;
    submit(iso);
  }

  function updateScore(rec) {
    var s = state.session;
    $('score').textContent = s.score;
    $('streak').textContent = s.streak;
    $('streak-box').classList.toggle('is-hot', s.streak >= 5);
  }

  function markProgress(rec) {
    var s = state.session;
    var seg = $('progress-strip').children[s.index];
    if (!seg) return;
    if (s.mode === 'combo' && rec.part === 'capital') {
      var placeOk = s.answers[s.answers.length - 2].correct;
      seg.classList.remove('ok', 'bad', 'half', 'now');
      seg.classList.add(placeOk && rec.correct ? 'ok' : (placeOk || rec.correct ? 'half' : 'bad'));
    } else if (s.mode === 'combo') {
      seg.classList.add(rec.correct ? 'ok' : 'bad');
    } else {
      seg.classList.remove('now');
      seg.classList.add(rec.correct ? 'ok' : 'bad');
    }
  }

  function showFeedback(ok, html, withNext) {
    var fb = $('feedback');
    fb.className = 'feedback show ' + (ok ? 'ok' : 'bad');
    $('fb-icon').textContent = ok ? '✓' : '✕';
    $('fb-text').innerHTML = html;
    $('btn-next').hidden = !withNext;
    var card = $('question-card');
    card.classList.remove('state-ok', 'state-bad');
    card.classList.add(ok ? 'state-ok' : 'state-bad');
  }

  /* Ответ на текущий этап: ISO страны, столица или null («Не знаю»). */
  function submit(given) {
    var s = state.session;
    if (!s || state.locked || state.paused || Quiz.isFinished(s)) return;
    var rec = Quiz.answer(s, given);
    var c = rec.country;
    Storage.recordAnswer(rec.part, c.iso, rec.correct);
    updateScore(rec);
    markProgress(rec);
    (rec.correct ? sfx.ok : sfx.bad)();

    app.dataset.answered = 'yes';
    if (Quiz.isMapPart(rec.part)) answerPlace(rec, given);
    else answerCapital(rec, given);
  }

  function answerPlace(rec, given) {
    var s = state.session;
    var c = rec.country;
    var hl = state.highlight;
    var text;
    var reverse = rec.part === 'reverse';
    $('btn-skip').disabled = true;
    if (reverse) {
      var picked = given && byIso[given] ? 'Это <b>' + esc(byIso[given].name) + '</b>. ' : '';
      text = (rec.correct ? 'Верно: ' : picked) + esc(c.capital) + ' — столица <b class="' +
        (rec.correct ? 'ok' : 'hl') + '">' + esc(c.gen) + '</b>';
    }
    if (rec.correct) {
      if (!reverse) text = 'Верно, это <b class="ok">' + esc(c.name) + '</b>';
      if (hl) {
        map.addClass(c.iso, 'is-ok');
        map.addClass(c.iso, 'is-picked');
        if (!reverse) map.labelCountry(c.iso, c.name, 'ok');
      }
    } else {
      if (!reverse) {
        text = given && byIso[given] ? 'Это <b>' + esc(byIso[given].name) + '</b>. ' : '';
        text += hl ? '<b class="hl">' + esc(c.name) + '</b> отмечена на карте' : 'Неверно';
      }
      if (hl) {
        map.addClass(c.iso, 'is-bad');
        map.addClass(c.iso, 'is-reveal');
        if (given && byIso[given]) {
          map.addClass(given, 'is-wrong');
          map.labelCountry(given, byIso[given].name, 'wrong');
        }
        // В «Чья это столица?» страну подписывает отметка столицы — без второй подписи.
        if (!reverse) map.labelCountry(c.iso, c.name, 'reveal');
        map.raise(c.iso);
        if (!map.isWellVisible(c.iso)) {
          state.savedView = map.getView();
          state.userMoved = false;
          map.fitBox(contextBox(c.iso), { padding: 20, duration: 600 });
        }
      }
    }

    if (reverse && hl) map.labelCapital(c.iso, c.capital + ' — ' + c.name);

    if (s.mode === 'combo') {
      // Сразу переходим к столице этой же страны.
      state.placeText = text;
      state.placeOk = rec.correct;
      setQuestionText('capital');
      renderOptions(Quiz.current(s));
      setStage('capital');
      showFeedback(rec.correct, text, false);
      requestAnimationFrame(updateInsets);
      return;
    }
    setStage('review');
    finishAnswer(rec.correct, text);
  }

  function answerCapital(rec, given) {
    var s = state.session;
    var c = rec.country;
    map.removeClass(c.iso, 'is-target');
    if (state.highlight) {
      if (s.mode === 'capitals') map.addClass(c.iso, rec.correct ? 'is-ok' : 'is-bad');
      map.labelCapital(c.iso, c.capital);
    }
    Array.prototype.forEach.call($('options').children, function (b) {
      b.disabled = true;
      if (b.dataset.value === c.capital) b.classList.add('correct');
      else if (b.dataset.value === given) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    var text = (rec.correct ? 'Верно: ' : 'Неверно. ') + 'столица ' + esc(c.gen) + ' — <b class="' +
      (rec.correct ? 'ok' : 'hl') + '">' + esc(c.capital) + '</b>';
    if (rec.part === 'input') {
      var inp = $('answer-input');
      inp.disabled = true;
      inp.blur();
      $('btn-answer').disabled = true;
      $('btn-input-skip').disabled = true;
      $('answer-form').className = 'answer-form ' + (rec.correct ? 'ok' : 'bad');
      if (rec.correct && rec.typo) {
        text = 'Засчитано, но с опечаткой. Правильно: <b class="hl">' + esc(c.capital) + '</b>';
      } else if (!rec.correct && given) {
        text = 'Неверно (ваш ответ: ' + esc(given) + '). Столица ' + esc(c.gen) + ' — <b class="hl">' + esc(c.capital) + '</b>';
      }
    }
    var ok = rec.correct;
    if (s.mode === 'combo') {
      ok = rec.correct && state.placeOk;
      text = state.placeText + '<span class="sep">·</span>' + text;
    }
    finishAnswer(ok, text);
  }

  function finishAnswer(ok, text) {
    state.locked = true;
    showFeedback(ok, text, true);
    scheduleNext(ok ? DELAY_OK : DELAY_BAD);
    requestAnimationFrame(updateInsets);
  }

  // --- Автопереход (с паузой) ---

  function scheduleNext(ms) {
    clearNext();
    state.next = { left: ms, due: 0, timer: null };
    var bar = $('next-timer');
    bar.style.setProperty('--dur', ms + 'ms');
    bar.className = 'next-timer';
    void bar.offsetWidth;
    bar.className = 'next-timer run';
    if (!state.paused) runNext();
  }

  function runNext() {
    var n = state.next;
    if (!n) return;
    n.due = Date.now() + n.left;
    n.timer = setTimeout(goNext, n.left);
  }

  function holdNext() {
    var n = state.next;
    if (!n || !n.timer) return;
    clearTimeout(n.timer);
    n.timer = null;
    n.left = Math.max(0, n.due - Date.now());
  }

  function clearNext() {
    if (state.next && state.next.timer) clearTimeout(state.next.timer);
    state.next = null;
  }

  function goNext() {
    if (state.screen !== 'game' || !state.locked || state.paused) return;
    clearNext();
    ['is-reveal', 'is-wrong', 'is-picked', 'is-target'].forEach(map.clearClass, map);
    map.clearLabels();
    var s = state.session;
    Quiz.next(s);
    if (Quiz.isFinished(s)) { finishGame(); return; }
    // Если карту приближали для показа ответа и пользователь её не трогал — вернуть вид.
    if (state.savedView && !state.userMoved && s.mode !== 'capitals') map.animateTo(state.savedView, 500);
    state.savedView = null;
    renderQuestion();
  }

  // --- Пауза ---

  function pause() {
    if (state.screen !== 'game' || state.paused) return;
    state.paused = true;
    state.pausedAt = Date.now();
    holdNext();
    app.classList.add('is-paused');
    updateClock();
    $('pause').hidden = false;
    $('pause-resume').focus();
  }

  function resume() {
    if (!state.paused) return;
    var s = state.session;
    // Время паузы не входит в результат.
    if (s) s.startedAt += Date.now() - state.pausedAt;
    state.paused = false;
    app.classList.remove('is-paused');
    $('pause').hidden = true;
    runNext();
    updateClock();
  }

  // ---------------------------------------------------------------------
  // Результат

  function finishGame() {
    var s = state.session;
    stopGame();
    updateClock();
    var sum = Quiz.summary(s);
    var isRecord = Storage.recordGame(s.mode, s.region, sum, state.practice, s.variant);
    sfx.done();
    setStage('');

    $('result-kicker').textContent = (state.practice ? 'Работа над ошибками · ' : '') +
      modeTitle(s.mode, s.variant) + ' · ' + REGIONS[s.region].title;
    $('res-score').textContent = sum.score + ' из ' + sum.total;
    $('res-percent').textContent = sum.percent + '%';
    var bar = $('res-bar');
    bar.style.width = '0';
    bar.style.background = sum.percent >= 90 ? 'var(--ok)' : sum.percent >= 60 ? 'var(--reveal)' : 'var(--bad)';
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.width = sum.percent + '%'; }); });
    $('res-meta').innerHTML = 'Время ' + formatTime(sum.timeMs) + ' · лучшая серия ' + sum.bestStreak +
      (isRecord ? ' · <span class="record">новый рекорд</span>' : '');

    var list = $('mistake-list');
    list.innerHTML = '';
    $('mistakes-title').textContent = sum.mistakes.length ? 'Ошибки (' + sum.mistakes.length + ')' : 'Ошибки';
    $('btn-fix').hidden = !sum.mistakes.length;
    $('mistakes-hint').hidden = !sum.mistakes.length;
    if (!sum.mistakes.length) list.innerHTML = '<li class="no-mistakes">Ошибок нет.</li>';
    sum.mistakes.forEach(function (m) {
      var c = m.country;
      var li = document.createElement('li');
      li.className = 'mistake';
      li.tabIndex = 0;
      li.dataset.iso = c.iso;
      var what = s.mode === 'combo' ? (m.part === 'place' ? 'Место на карте: ' : 'Столица: ') : '';
      var given;
      if (m.given == null) given = 'не знаю';
      else if (Quiz.isMapPart(m.part)) given = 'указано ' + (byIso[m.given] ? byIso[m.given].name : '—');
      else given = 'ответ ' + m.given;
      li.innerHTML = '<b>' + esc(c.name) + '</b><span class="cap">' + esc(c.capital) + '</span>' +
        '<span class="given">' + esc(what + given) + '</span>';
      list.appendChild(li);
    });

    var isos = [];
    sum.mistakes.forEach(function (m) { if (isos.indexOf(m.country.iso) === -1) isos.push(m.country.iso); });
    state.lastResult = { mistakes: isos, mode: s.mode, variant: s.variant, region: s.region };
    setScreen('result');
    $('result').scrollTop = 0;
    fitRegion(s.region);
  }

  // ---------------------------------------------------------------------
  // Атлас и показ страны из списка ошибок

  function focusCountry(iso, fromMap) {
    var c = byIso[iso];
    map.clearClass('is-focus');
    map.clearLabels();
    map.addClass(iso, 'is-focus');
    map.labelCountry(iso, c.name, 'country');
    map.labelCapital(iso, c.capital);
    Array.prototype.forEach.call(document.querySelectorAll('.mistake'), function (li) {
      li.classList.toggle('active', li.dataset.iso === iso);
    });
    if (!fromMap || !map.isWellVisible(iso)) map.fitBox(contextBox(iso), { padding: 24, duration: 650 });
  }

  function startStudy() {
    stopGame();
    map.resetStates();
    map.clearClass('is-focus');
    map.setActive(regionIsos(state.region));
    $('q-kicker').textContent = 'Атлас · ' + REGIONS[state.region].title;
    $('question').innerHTML = 'Наведите или нажмите на <b>страну</b>';
    $('feedback').className = 'feedback';
    $('question-card').classList.remove('state-ok', 'state-bad');
    setStage('');
    setScreen('study');
    requestAnimationFrame(function () { updateInsets(); fitRegion(state.region); });
  }

  var tooltip = $('tooltip');
  function onHover(iso, x, y) {
    if (state.screen !== 'study' || !iso || !byIso[iso] || map.paths[iso].classList.contains('is-inactive')) {
      hideTooltip();
      return;
    }
    var c = byIso[iso];
    tooltip.innerHTML = '<b>' + esc(c.name) + '</b><span>Столица: ' + esc(c.capital) + '</span>';
    tooltip.hidden = false;
    var w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    tooltip.style.left = Math.min(x, window.innerWidth - w - 24) + 'px';
    tooltip.style.top = Math.min(y, window.innerHeight - h - 24) + 'px';
  }
  function hideTooltip() { tooltip.hidden = true; }

  // ---------------------------------------------------------------------
  // Выход

  function requestExit() {
    if (state.screen === 'study') { showMenu(); return; }
    if (state.screen !== 'game') return;
    var s = state.session;
    if (s && s.answers.length && !Quiz.isFinished(s)) {
      if (!state.paused) pause();
      $('pause').hidden = true;
      $('confirm').hidden = false;
      $('confirm-no').focus();
    } else {
      showMenu();
    }
  }

  // ---------------------------------------------------------------------
  // События

  $('mode-seg').addEventListener('click', function (e) {
    var b = e.target.closest('[role="radio"]');
    if (!b) return;
    state.mode = b.dataset.value;
    app.dataset.mode = state.mode;
    Storage.setSetting('mode', state.mode);
    renderMenu();
  });

  $('variant-seg').addEventListener('click', function (e) {
    var b = e.target.closest('[role="radio"]');
    if (!b) return;
    state.variant = b.dataset.value;
    Storage.setSetting('capVariant', state.variant);
    renderMenu();
  });

  $('btn-known').addEventListener('click', markKnown);

  $('answer-form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.locked || state.paused || app.dataset.stage !== 'input') return;
    var v = $('answer-input').value.trim();
    if (!v) { $('answer-input').focus(); return; }
    submit(v);
  });
  $('btn-input-skip').addEventListener('click', function () {
    if (!state.locked && app.dataset.stage === 'input') submit(null);
  });

  // --- Окно «Известные столицы» ---

  function renderKnownList() {
    var known = Storage.knownList();
    var html = '';
    var groups = ['europe'].concat(window.GEO_DATA.ASIA_GROUPS.map(function (g) { return g.key; }), ['oceania']);
    groups.forEach(function (r) {
      html += '<h4>' + esc((REGIONS[r].parent ? 'Азия: ' : '') + REGIONS[r].title) + '</h4><div class="known-grid">';
      regionIsos(r).map(function (iso) { return byIso[iso]; }).forEach(function (c) {
        html += '<label><input type="checkbox" data-iso="' + c.iso + '"' + (known.indexOf(c.iso) !== -1 ? ' checked' : '') +
          '><span class="kn">' + esc(c.name) + ' <i>— ' + esc(c.capital) + '</i></span></label>';
      });
      html += '</div>';
    });
    $('known-list').innerHTML = html;
  }

  $('btn-known-list').addEventListener('click', function () {
    renderKnownList();
    $('known-modal').hidden = false;
    $('known-done').focus();
  });
  $('known-list').addEventListener('change', function (e) {
    if (e.target.dataset.iso) Storage.setKnown(e.target.dataset.iso, e.target.checked);
  });
  $('known-clear').addEventListener('click', function () {
    Storage.clearKnown();
    renderKnownList();
  });
  function closeKnown() {
    $('known-modal').hidden = true;
    renderMenu();
  }
  $('known-done').addEventListener('click', closeKnown);
  $('known-modal').addEventListener('click', function (e) { if (e.target === this) closeKnown(); });

  function selectRegion(e) {
    var b = e.target.closest('[role="radio"]');
    if (!b) return;
    // Повторный клик по «Азии», когда выбрана её часть, не сбрасывает выбор.
    if (b.dataset.value === 'asia' && this.id === 'region-seg' && REGIONS[state.region].parent === 'asia') return;
    state.region = b.dataset.value;
    Storage.setSetting('region', state.region);
    map.setActive(regionIsos(state.region));
    renderMenu();
    updateInsets();
    fitRegion(state.region);
  }
  $('region-seg').addEventListener('click', selectRegion);
  $('asia-seg').addEventListener('click', selectRegion);

  $('hl-seg').addEventListener('click', function (e) {
    var b = e.target.closest('[role="radio"]');
    if (!b) return;
    state.highlight = b.dataset.value === 'on';
    Storage.setSetting('highlight', state.highlight);
    applyHighlightSetting();
    renderMenu();
  });

  $('btn-start').addEventListener('click', function () {
    startGame({ mode: state.mode, variant: state.variant, region: state.region });
  });

  $('btn-mistakes').addEventListener('click', function () {
    var lm = Storage.load().lastMistakes;
    if (!lm) return;
    startGame({ mode: lm.mode, variant: lm.variant, region: lm.region, isoFilter: lm.isos.slice() });
  });

  $('btn-weak').addEventListener('click', function () {
    var weak = Storage.weakest(state.mode, 10);
    if (!weak.length) return;
    startGame({ mode: state.mode, variant: state.variant, region: 'all', isoFilter: weak.map(function (w) { return w.iso; }) });
  });

  $('btn-study').addEventListener('click', startStudy);

  $('btn-again').addEventListener('click', function () {
    if (state.lastStart) startGame(state.lastStart);
  });

  $('btn-fix').addEventListener('click', function () {
    var r = state.lastResult;
    if (r && r.mistakes.length) startGame({ mode: r.mode, variant: r.variant, region: r.region, isoFilter: r.mistakes.slice() });
  });

  $('btn-menu').addEventListener('click', showMenu);
  $('btn-exit').addEventListener('click', requestExit);
  $('btn-pause').addEventListener('click', pause);
  $('pause-resume').addEventListener('click', resume);
  $('pause-menu').addEventListener('click', function () { $('pause').hidden = true; showMenu(); });
  $('confirm-no').addEventListener('click', function () { $('confirm').hidden = true; resume(); });
  $('confirm-yes').addEventListener('click', function () { $('confirm').hidden = true; showMenu(); });

  $('btn-next').addEventListener('click', goNext);
  $('btn-skip').addEventListener('click', function () {
    if (state.screen === 'game' && app.dataset.stage === 'place') submit(null);
  });

  $('options').addEventListener('click', function (e) {
    var b = e.target.closest('.option');
    if (!b || b.disabled || state.locked) return;
    submit(b.dataset.value);
  });

  $('mistake-list').addEventListener('click', function (e) {
    var li = e.target.closest('.mistake');
    if (li) focusCountry(li.dataset.iso, false);
  });
  $('mistake-list').addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('mistake')) {
      e.preventDefault();
      focusCountry(e.target.dataset.iso, false);
    }
  });

  $('sound-toggle').addEventListener('change', function () {
    Storage.setSetting('sound', this.checked);
    if (this.checked) sfx.ok();
  });

  $('btn-reset').addEventListener('click', function () {
    if (window.confirm('Сбросить всю статистику и рекорды?')) {
      Storage.reset();
      renderMenu();
    }
  });

  $('zoom-in').addEventListener('click', function () { map.zoomBy(1.5); });
  $('zoom-out').addEventListener('click', function () { map.zoomBy(1 / 1.5); });
  $('zoom-fit').addEventListener('click', fitCurrent);

  function fitCurrent() {
    var region = state.screen === 'game' && state.session ? state.session.region : state.region;
    if (state.screen === 'result' && state.lastResult) region = state.lastResult.region;
    fitRegion(region);
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      // Из поля ввода работает только Esc.
      if (e.key !== 'Escape') return;
      e.target.blur();
    }
    if (!$('confirm').hidden) {
      if (e.key === 'Escape') { $('confirm').hidden = true; resume(); }
      return;
    }
    if (!$('known-modal').hidden) {
      if (e.key === 'Escape') closeKnown();
      return;
    }
    if (!$('pause').hidden) {
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P' || e.key === 'з' || e.key === 'З') resume();
      return;
    }
    if (e.key === 'Escape') { requestExit(); return; }
    if (e.key === '+' || e.key === '=') { map.zoomBy(1.5); return; }
    if (e.key === '-' || e.key === '_') { map.zoomBy(1 / 1.5); return; }
    if (e.key === '0') { fitCurrent(); return; }
    if (state.screen !== 'game') return;
    if (e.key === 'p' || e.key === 'P' || e.key === 'з' || e.key === 'З') { pause(); return; }
    if (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л') { markKnown(); return; }
    if (state.locked && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight')) {
      e.preventDefault();
      goNext();
      return;
    }
    if (!state.locked && app.dataset.stage === 'capital' && /^[1-4]$/.test(e.key)) {
      var b = $('options').children[Number(e.key) - 1];
      if (b) submit(b.dataset.value);
    }
  });

  // Свернули вкладку посреди теста — ставим на паузу.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.screen === 'game' && state.session && !Quiz.isFinished(state.session)) pause();
  });

  // Экранная клавиатура телефона не должна закрывать поле ввода столицы.
  if (window.visualViewport) {
    var onViewport = function () {
      var vv = window.visualViewport;
      var kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      app.style.setProperty('--kb', (kb > 80 ? kb : 0) + 'px');
      if (app.dataset.stage === 'input') updateInsets();
    };
    window.visualViewport.addEventListener('resize', onViewport);
    window.visualViewport.addEventListener('scroll', onViewport);
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateInsets, 120);
  });

  // Для автотестов.
  window.__geo = { state: state, map: map, byIso: byIso };

  applyHighlightSetting();
  showMenu();
})();
