/*
 * Прогресс и статистика в localStorage.
 * Любая ошибка хранилища (приватный режим, запрет cookies) не ломает игру:
 * тогда статистика просто живёт до перезагрузки страницы.
 */
(function (root) {
  'use strict';

  var KEY = 'geodictant.stats.v1';

  function empty() {
    return {
      games: 0,
      answered: 0,
      correct: 0,
      best: {},        // "map:europe" -> { score, total, percent, timeMs, date }
      countries: {},   // iso -> { map: [ok, bad], capitals: [ok, bad] }
      lastMistakes: null, // { mode, region, isos: [] }
      known: [],       // ISO стран, чьи столицы отмечены как известные
      settings: { sound: true, mode: 'map', region: 'all', highlight: true, capVariant: 'choice' }
    };
  }

  var memory = null;

  function load() {
    if (memory) return memory;
    var data = empty();
    try {
      var raw = root.localStorage && root.localStorage.getItem(KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (var k in data) if (parsed[k] != null) data[k] = parsed[k];
          data.settings = Object.assign(empty().settings, parsed.settings || {});
        }
      }
    } catch (e) { /* хранилище недоступно или повреждено */ }
    memory = data;
    return data;
  }

  function save() {
    try {
      if (root.localStorage) root.localStorage.setItem(KEY, JSON.stringify(memory));
    } catch (e) { /* без сохранения */ }
  }

  /* part: 'place' — страна на карте; остальные виды вопросов — знание столицы. */
  function recordAnswer(part, iso, ok) {
    var s = load();
    var entry = s.countries[iso] || (s.countries[iso] = { map: [0, 0], capitals: [0, 0] });
    entry[part === 'place' ? 'map' : 'capitals'][ok ? 0 : 1]++;
    s.answered++;
    if (ok) s.correct++;
    save();
  }

  /* Ключ рекорда: режим (с вариантом для «Столиц») и регион. */
  function bestKey(mode, variant, region) {
    return mode + (mode === 'capitals' && variant && variant !== 'choice' ? '-' + variant : '') + ':' + region;
  }

  /* Возвращает true, если это новый рекорд для режима/варианта/региона. */
  function recordGame(mode, region, sum, isPractice, variant) {
    var s = load();
    s.games++;
    var isos = [];
    sum.mistakes.forEach(function (m) { if (isos.indexOf(m.country.iso) === -1) isos.push(m.country.iso); });
    s.lastMistakes = isos.length ? { mode: mode, variant: variant || null, region: region, isos: isos } : null;
    var isRecord = false;
    if (!isPractice) {
      var key = bestKey(mode, variant, region);
      var prev = s.best[key];
      if (!prev || sum.score > prev.score || (sum.score === prev.score && sum.timeMs < prev.timeMs)) {
        s.best[key] = { score: sum.score, total: sum.total, percent: sum.percent, timeMs: sum.timeMs, date: Date.now() };
        isRecord = true;
      }
    }
    save();
    return isRecord;
  }

  /* Страны с наибольшей долей ошибок в выбранном режиме ('combo' — оба вида вопросов). */
  function weakest(mode, limit) {
    var s = load();
    var list = [];
    for (var iso in s.countries) {
      var e = s.countries[iso];
      var r = mode === 'combo'
        ? [e.map[0] + e.capitals[0], e.map[1] + e.capitals[1]]
        : e[mode === 'capitals' ? 'capitals' : 'map'];
      if (!r || r[1] === 0) continue;
      list.push({ iso: iso, ok: r[0], bad: r[1], rate: r[1] / (r[0] + r[1]) });
    }
    list.sort(function (a, b) { return b.rate - a.rate || b.bad - a.bad; });
    return list.slice(0, limit || 8);
  }

  // --- Известные столицы ---

  function knownList() {
    var k = load().known;
    return Array.isArray(k) ? k.slice() : [];
  }

  function setKnown(iso, on) {
    var s = load();
    if (!Array.isArray(s.known)) s.known = [];
    var i = s.known.indexOf(iso);
    if (on && i === -1) s.known.push(iso);
    if (!on && i !== -1) s.known.splice(i, 1);
    save();
  }

  function clearKnown() {
    load().known = [];
    save();
  }

  function setSetting(name, value) {
    load().settings[name] = value;
    save();
  }

  /* Сбрасывает статистику; настройки и список известных столиц остаются. */
  function reset() {
    var settings = load().settings;
    var known = knownList();
    memory = empty();
    memory.settings = settings;
    memory.known = known;
    save();
  }

  root.Storage = {
    load: load,
    recordAnswer: recordAnswer,
    recordGame: recordGame,
    weakest: weakest,
    bestKey: bestKey,
    knownList: knownList,
    setKnown: setKnown,
    clearKnown: clearKnown,
    setSetting: setSetting,
    reset: reset
  };
})(window);
