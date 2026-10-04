/* Юнит-тесты: данные и движок теста.  Запуск: node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { COUNTRIES, REGIONS } = require('../js/data.js');
const Quiz = require('../js/quiz.js');

function loadMapData() {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/map-data.js'), 'utf8'), ctx);
  return ctx.window.MAP_DATA;
}

test('данные совпадают с исходным списком дословно', () => {
  const lines = fs.readFileSync(path.join(__dirname, 'source-list.txt'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 90);
  assert.equal(COUNTRIES.length, 90);
  lines.forEach((line, i) => {
    const m = line.match(/^(\d+)\.\s+(.+?)\s+[—–]\s+(.+?)[;.]$/);
    assert.ok(m, 'не разобрана строка: ' + line);
    const c = COUNTRIES[i];
    assert.equal(c.n, Number(m[1]));
    assert.equal(c.name, m[2], 'название №' + m[1]);
    assert.equal(c.capital, m[3], 'столица №' + m[1]);
  });
});

test('регионы соответствуют разделам списка', () => {
  for (const c of COUNTRIES) {
    const expected = c.n <= 39 ? 'europe' : c.n <= 85 ? 'asia' : 'oceania';
    assert.equal(c.region, expected, c.name);
  }
  assert.equal(COUNTRIES.filter((c) => c.region === 'europe').length, 39);
  assert.equal(COUNTRIES.filter((c) => c.region === 'asia').length, 46);
  assert.equal(COUNTRIES.filter((c) => c.region === 'oceania').length, 5);
  assert.deepEqual(Object.keys(REGIONS).slice(0, 4), ['all', 'europe', 'asia', 'oceania']);
});

test('у каждой страны своя геометрия, столица лежит в пределах страны', () => {
  const map = loadMapData();
  const isos = new Set();
  for (const c of COUNTRIES) {
    assert.ok(!isos.has(c.iso), 'повтор ISO ' + c.iso);
    isos.add(c.iso);
    const g = map.countries[c.iso];
    assert.ok(g, 'нет геометрии: ' + c.name);
    assert.ok(g.d.length > 20, 'пустой контур: ' + c.name);
    assert.ok(g.area > 0, 'нулевая площадь: ' + c.name);
    const [x0, y0, x1, y1] = g.box;
    assert.ok(x1 > x0 && y1 > y0, 'рамка: ' + c.name);
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= map.width && y1 <= map.height, 'страна за краем карты: ' + c.name);
    const tol = 3;
    assert.ok(g.cap[0] >= x0 - tol && g.cap[0] <= x1 + tol && g.cap[1] >= y0 - tol && g.cap[1] <= y1 + tol,
      'столица вне страны: ' + c.name + ' ' + JSON.stringify(g.cap) + ' ' + JSON.stringify(g.box));
    assert.ok(g.c[0] >= x0 && g.c[0] <= x1 && g.c[1] >= y0 && g.c[1] <= y1, 'точка подписи: ' + c.name);
  }
  assert.equal(Object.keys(map.countries).length, 90);
});

test('родительный падеж и множественное число в вопросах', () => {
  for (const c of COUNTRIES) assert.ok(c.gen && c.gen.length >= 3, c.name);
  const by = (n) => COUNTRIES.find((c) => c.name === n);
  assert.deepEqual(Quiz.questionParts('map', by('Австрия')), { before: 'Где находится ', subject: 'Австрия', after: '?' });
  assert.deepEqual(Quiz.questionParts('capitals', by('Австрия')), { before: 'Столица ', subject: 'Австрии', after: '?' });
  for (const n of ['Нидерланды', 'Мальдивы', 'ОАЭ', 'Филиппины', 'Соломоновы острова']) {
    assert.equal(Quiz.questionParts('map', by(n)).before, 'Где находятся ', n);
  }
});

test('сессия: все страны региона ровно по одному разу, порядок случайный', () => {
  for (const region of ['all', 'europe', 'asia', 'oceania']) {
    const s = Quiz.createSession({ countries: COUNTRIES, mode: 'map', region, seed: 7 });
    const expected = COUNTRIES.filter((c) => region === 'all' || c.region === region).map((c) => c.iso).sort();
    assert.deepEqual(s.questions.map((q) => q.country.iso).sort(), expected);
  }
  const a = Quiz.createSession({ countries: COUNTRIES, mode: 'map', region: 'all', seed: 1 });
  const b = Quiz.createSession({ countries: COUNTRIES, mode: 'map', region: 'all', seed: 2 });
  assert.notDeepEqual(a.questions.map((q) => q.country.iso), b.questions.map((q) => q.country.iso));
  assert.notDeepEqual(a.questions.map((q) => q.country.n), COUNTRIES.map((c) => c.n));
});

test('варианты столиц: 4 разных, ровно один верный, для всех стран', () => {
  for (let seed = 0; seed < 25; seed++) {
    const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'all', seed });
    for (const q of s.questions) {
      assert.equal(q.options.length, 4);
      assert.equal(new Set(q.options).size, 4, q.country.name);
      assert.equal(q.options.filter((o) => o === q.country.capital).length, 1);
      const all = new Set(COUNTRIES.map((c) => c.capital));
      for (const o of q.options) assert.ok(all.has(o), 'чужая столица: ' + o);
    }
  }
  // Правильный ответ не всегда на одной позиции
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'all', seed: 3 });
  const positions = new Set(s.questions.map((q) => q.options.indexOf(q.country.capital)));
  assert.equal(positions.size, 4);
});

test('Океания: варианты добираются из других регионов', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'oceania', seed: 5 });
  assert.equal(s.questions.length, 5);
  for (const q of s.questions) assert.equal(new Set(q.options).size, 4);
});

test('подсчёт очков, серия, ошибки и завершение', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'map', region: 'oceania', seed: 9, now: 1000 });
  const qs = s.questions.map((q) => q.country);
  assert.equal(Quiz.answer(s, qs[0].iso).correct, true); Quiz.next(s);
  assert.equal(Quiz.answer(s, qs[1].iso).correct, true); Quiz.next(s);
  assert.equal(s.streak, 2);
  assert.equal(Quiz.answer(s, '276').correct, false); Quiz.next(s); // Германия
  assert.equal(s.streak, 0);
  assert.equal(Quiz.answer(s, null).correct, false); Quiz.next(s);  // «Не знаю»
  assert.equal(Quiz.answer(s, qs[4].iso).correct, true);
  assert.equal(Quiz.isFinished(s), false);
  Quiz.next(s, 61000);
  assert.equal(Quiz.isFinished(s), true);
  const sum = Quiz.summary(s);
  assert.equal(sum.score, 3);
  assert.equal(sum.total, 5);
  assert.equal(sum.percent, 60);
  assert.equal(sum.bestStreak, 2);
  assert.equal(sum.timeMs, 60000);
  assert.deepEqual(sum.mistakes.map((m) => m.given), ['276', null]);
  assert.throws(() => Quiz.answer(s, 'x'));
});

test('режим столиц: ответ сравнивается со столицей из списка', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'all', isoFilter: ['376'], seed: 1 });
  assert.equal(s.questions.length, 1);
  assert.equal(Quiz.answer(s, 'Тель-Авив').correct, true);
});

test('работа над ошибками: только выбранные страны', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'map', region: 'europe', isoFilter: ['040', '470', '360'], seed: 1 });
  // Индонезия (Азия) не попадает в европейский набор
  assert.deepEqual(s.questions.map((q) => q.country.iso).sort(), ['040', '470']);
});

test('режим «Страны + столицы»: два этапа на каждую страну', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'combo', region: 'oceania', seed: 4, now: 0 });
  assert.equal(s.questions.length, 5);
  for (const q of s.questions) assert.equal(q.options.length, 4);
  const q0 = Quiz.current(s).country;
  assert.equal(Quiz.part(s), 'place');
  assert.deepEqual(Quiz.questionParts('combo', q0, 'place').before.startsWith('Где наход'), true);
  const r1 = Quiz.answer(s, q0.iso);
  assert.equal(r1.part, 'place');
  assert.equal(r1.correct, true);
  assert.equal(Quiz.awaitingCapital(s), true);
  assert.equal(Quiz.part(s), 'capital');
  assert.equal(Quiz.current(s).country, q0, 'вопрос о столице — про ту же страну');
  const r2 = Quiz.answer(s, 'Москва');
  assert.equal(r2.part, 'capital');
  assert.equal(r2.correct, false);
  assert.equal(Quiz.awaitingCapital(s), false);
  Quiz.next(s);
  assert.equal(Quiz.part(s), 'place');
  for (let i = 1; i < 5; i++) {
    const c = Quiz.current(s).country;
    Quiz.answer(s, c.iso);
    Quiz.answer(s, c.capital);
    Quiz.next(s, 1000);
  }
  const sum = Quiz.summary(s);
  assert.equal(sum.total, 10);
  assert.equal(sum.score, 9);
  assert.equal(sum.mistakes.length, 1);
  assert.equal(sum.mistakes[0].part, 'capital');
});

test('ввод столицы: регистр, «ё», дефисы и опечатки', () => {
  const m = Quiz.matchCapital;
  assert.deepEqual(m('вена', 'Вена'), { ok: true, typo: false });
  assert.deepEqual(m('  КИШИНЕВ ', 'Кишинёв'), { ok: true, typo: false });
  assert.deepEqual(m('бандар сери бегаван', 'Бандар-Сери-Бегаван'), { ok: true, typo: false });
  assert.deepEqual(m('нью дели', 'Нью-Дели'), { ok: true, typo: false });
  assert.deepEqual(m('Таллинн', 'Таллин'), { ok: true, typo: true });       // лишняя буква
  assert.deepEqual(m('Будапешд', 'Будапешт'), { ok: true, typo: true });
  assert.deepEqual(m('Рим', 'Рим'), { ok: true, typo: false });
  assert.equal(m('Рига', 'Рим').ok, false);                                   // короткие — без поблажек
  assert.equal(m('Баку', 'Бака').ok, false);
  assert.equal(m('Вена', 'Берн').ok, false);
  assert.equal(m('Варшава', 'Вашингтон').ok, false);
  assert.equal(m('', 'Вена').ok, false);
  assert.equal(m(null, 'Вена').ok, false);
  // Все столицы из списка принимаются в точном написании
  for (const c of COUNTRIES) assert.equal(m(c.capital, c.capital).typo, false, c.capital);
  // Ни одна столица не засчитывается вместо другой из-за поблажки на опечатки
  for (const a of COUNTRIES) for (const b of COUNTRIES) {
    if (a.capital !== b.capital) assert.equal(m(a.capital, b.capital).ok, false, a.capital + ' / ' + b.capital);
  }
});

test('режим «Чья это столица?»: ответ — страна на карте', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', variant: 'reverse', region: 'asia', seed: 2 });
  assert.equal(Quiz.part(s), 'reverse');
  const c = Quiz.current(s).country;
  assert.deepEqual(Quiz.questionParts('capitals', c, 'reverse'), { before: '', subject: c.capital, after: ' — столица какой страны?' });
  const r = Quiz.answer(s, c.iso);
  assert.equal(r.correct, true);
  assert.equal(r.part, 'reverse');
});

test('режим ввода: part input, вопрос «Столица …?»', () => {
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', variant: 'input', region: 'all', isoFilter: ['064'], seed: 2 });
  assert.equal(Quiz.part(s), 'input');
  assert.equal(Quiz.questionParts('capitals', Quiz.current(s).country, 'input').subject, 'Бутана');
  const r = Quiz.answer(s, 'тхимпу');
  assert.equal(r.correct, true);
  assert.equal(r.typo, true);
});

test('известные столицы исключаются, «Знаю» убирает вопрос без оценки', () => {
  const exclude = ['276', '643'];
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'europe', exclude, seed: 3 });
  assert.equal(s.questions.length, 37);
  assert.ok(!s.questions.some((q) => exclude.includes(q.country.iso)));
  const first = Quiz.current(s).country;
  Quiz.dropCurrent(s);
  assert.equal(s.questions.length, 36);
  assert.notEqual(Quiz.current(s).country, first);
  assert.equal(s.answers.length, 0);
  const one = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'all', isoFilter: ['040'], seed: 1 });
  Quiz.dropCurrent(one);
  assert.equal(Quiz.isFinished(one), true);
  assert.equal(Quiz.summary(one).total, 0);
});

test('части Азии: каждая азиатская страна ровно в одной группе', () => {
  const { ASIA_GROUPS, inRegion } = require('../js/data.js');
  const asia = COUNTRIES.filter((c) => c.region === 'asia');
  assert.equal(asia.length, 46);
  for (const c of asia) assert.ok(c.sub && REGIONS[c.sub].parent === 'asia', c.name);
  for (const c of COUNTRIES.filter((x) => x.region !== 'asia')) assert.equal(c.sub, undefined, c.name);
  const sizes = ASIA_GROUPS.map((g) => COUNTRIES.filter((c) => inRegion(c, g.key)).length);
  assert.equal(sizes.reduce((a, b) => a + b, 0), 46);
  assert.deepEqual(sizes, ASIA_GROUPS.map((g) => g.names.length));
  // Сессия по части Азии: только её страны; варианты столиц — в первую очередь соседей
  const s = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'asia-central', seed: 3 });
  assert.equal(s.questions.length, 5);
  for (const q of s.questions) {
    assert.equal(q.country.sub, 'asia-central');
    const neighbours = q.options.filter((o) => COUNTRIES.find((c) => c.capital === o).sub === 'asia-central');
    assert.equal(neighbours.length, 4, 'все варианты — столицы Средней Азии: ' + q.options);
  }
  const s2 = Quiz.createSession({ countries: COUNTRIES, mode: 'capitals', region: 'asia-caucasus', seed: 1 });
  for (const q of s2.questions) assert.equal(new Set(q.options).size, 4);
});

test('однофайловая сборка geodiktant.html не устарела', () => {
  const root = path.join(__dirname, '..');
  const single = fs.readFileSync(path.join(root, 'geodiktant.html'), 'utf8');
  for (const f of ['css/style.css', 'js/data.js', 'js/map-data.js', 'js/quiz.js', 'js/storage.js', 'js/map.js', 'js/app.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/<\/script/gi, '<\\/script');
    assert.ok(single.includes(src), f + ' изменился — пересоберите: cd tools && npm run single');
  }
  assert.ok(!/<script src=|<link rel="stylesheet"/.test(single));
});
