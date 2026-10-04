/*
 * Сквозные тесты в настоящем браузере (Playwright + Chromium).
 * Запуск:  node tests/e2e.js   (нужен пакет playwright; путь можно задать в PLAYWRIGHT_PATH)
 * Скриншоты сохраняются в каталог из SHOTS_DIR (по умолчанию — не сохраняются).
 */
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

// TARGET=geodiktant.html — проверить однофайловую сборку
const URL = 'file://' + path.resolve(__dirname, '..', process.env.TARGET || 'index.html');
const SHOTS = process.env.SHOTS_DIR || null;
const results = [];

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function step(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
    console.log('  ✓ ' + name);
  } catch (e) {
    results.push(['fail', name, e]);
    console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e));
  }
}

/* Находит видимую точку страны на экране (с приближением карты к ней). */
async function pointOf(page, iso, { zoom = true } = {}) {
  return page.evaluate(({ iso, zoom }) => {
    const m = window.__geo.map;
    const data = window.MAP_DATA.countries[iso];
    if (zoom) {
      const b = data.box;
      const size = Math.max(b[2] - b[0], b[3] - b[1]);
      const pad = Math.max(size * 0.45, 60);
      m.fitBox([b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad], { animate: false });
    }
    const hit = (x, y) => {
      const p = m.toClient(x, y);
      const el = document.elementFromPoint(p.x, p.y);
      const t = el && el.closest && el.closest('[data-iso]');
      return t && t.getAttribute('data-iso') === iso ? p : null;
    };
    let p = hit(data.c[0], data.c[1]);
    if (p) return p;
    const [x0, y0, x1, y1] = data.box;
    for (let i = 1; i < 24 && !p; i++) {
      for (let j = 1; j < 24 && !p; j++) p = hit(x0 + (x1 - x0) * i / 24, y0 + (y1 - y0) * j / 24);
    }
    return p;
  }, { iso, zoom });
}

const current = (page) => page.evaluate(() => {
  const s = window.__geo.state.session;
  const q = s.questions[s.index];
  return q ? {
    iso: q.country.iso, name: q.country.name, capital: q.country.capital, options: q.options,
    index: s.index, stage: document.getElementById('app').dataset.stage
  } : null;
});

const view = (page) => page.evaluate(() => window.__geo.map.getView());

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(500);

  await step('стартовый экран: меню, 90 стран на карте', async () => {
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'menu');
    assert.equal(await page.locator('path.country').count(), 90);
    assert.match(await page.textContent('#start-hint'), /90 стран/);
    await shot(page, '01-menu');
  });

  await step('режим «Страны»: все 90 стран кликаются и засчитываются', async () => {
    await page.click('#btn-start');
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'game');
    assert.equal(await page.textContent('#q-total'), '90');
    const seen = new Set();
    for (let i = 0; i < 90; i++) {
      const q = await current(page);
      seen.add(q.iso);
      const qText = await page.textContent('#question');
      assert.ok(qText.includes(q.name), 'вопрос: ' + qText);
      assert.match(qText, /^Где наход(ится|ятся) /);
      const p = await pointOf(page, q.iso);
      assert.ok(p, 'не найдена точка для клика: ' + q.name);
      await page.mouse.click(p.x, p.y);
      const fb = await page.getAttribute('#feedback', 'class');
      assert.ok(fb.includes('ok'), 'ответ не засчитан: ' + q.name + ' / ' + fb);
      if (i === 0) await shot(page, '02-map-correct');
      assert.equal(await page.textContent('#score'), String(i + 1));
      await page.keyboard.press('Enter');
    }
    assert.equal(seen.size, 90);
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'result');
    assert.equal(await page.textContent('#res-percent'), '100%');
    assert.equal(await page.textContent('#res-score'), '90 из 90');
    assert.match(await page.textContent('#res-meta'), /новый рекорд/);
    await page.waitForTimeout(800);
    await shot(page, '03-result-perfect');
  });

  await step('ошибка на карте: подсветка правильной страны; перемещение карты не сбивает «Далее»', async () => {
    await page.click('#btn-menu');
    await page.click('#region-seg [data-value="europe"]');
    await page.click('#btn-start');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#q-total'), '39');
    const q = await current(page);
    const wrongIso = q.iso === '276' ? '250' : '276';
    const p = await pointOf(page, wrongIso);
    await page.mouse.click(p.x, p.y);
    assert.match(await page.getAttribute('#feedback', 'class'), /bad/);
    assert.equal(await page.locator(`path.country[data-iso="${q.iso}"].is-reveal`).count(), 1);
    assert.equal(await page.locator(`path.country[data-iso="${wrongIso}"].is-wrong`).count(), 1);
    assert.ok((await page.textContent('#fb-text')).includes(q.name));
    assert.equal(await page.locator('.labels .label').count(), 2);
    assert.equal(await page.textContent('#streak'), '0');
    await page.waitForTimeout(700);
    await shot(page, '04-map-wrong');
    await page.mouse.move(700, 500);
    await page.mouse.down(); await page.mouse.move(760, 540, { steps: 4 }); await page.mouse.up();
    assert.match(await page.getAttribute('#next-timer', 'class'), /run/);
    await page.waitForTimeout(2600);
    assert.equal((await current(page)).index, 1, 'автопереход должен сработать');
    assert.equal(await page.locator('.labels .label').count(), 0);
    assert.equal(await page.locator(`path.country[data-iso="${q.iso}"].is-bad`).count(), 1);
  });

  await step('«Не знаю» засчитывается как ошибка; автопереход после верного ответа', async () => {
    const q = await current(page);
    await page.click('#btn-skip');
    assert.match(await page.getAttribute('#feedback', 'class'), /bad/);
    assert.equal(await page.locator(`path.country[data-iso="${q.iso}"].is-reveal`).count(), 1);
    await page.click('#btn-next');
    const q2 = await current(page);
    const p = await pointOf(page, q2.iso);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(1500);
    assert.equal((await current(page)).index, q2.index + 1, 'нет автоперехода после верного ответа');
  });

  await step('страны вне выбранного региона неактивны', async () => {
    assert.equal(await page.locator('path.country.is-inactive').count(), 90 - 39);
    const before = await current(page);
    const p = await page.evaluate(() => {
      const m = window.__geo.map; m.showAll(false);
      const d = window.MAP_DATA.countries['156'];
      return m.toClient(d.c[0], d.c[1]);
    });
    await page.mouse.click(p.x, p.y);
    assert.equal((await current(page)).index, before.index);
    assert.doesNotMatch(await page.getAttribute('#feedback', 'class'), /show/);
  });

  await step('масштаб: кнопки, плавное колесо, точка под курсором на месте', async () => {
    await page.click('#zoom-fit'); await page.waitForTimeout(900);
    const k0 = (await view(page)).k;
    await page.click('#zoom-in'); await page.waitForTimeout(500);
    const k1 = (await view(page)).k;
    assert.ok(Math.abs(k1 / k0 - 1.5) < 0.02, `кнопка: ${k0} -> ${k1}`);
    await page.mouse.move(900, 500);
    await page.waitForTimeout(50);
    const before = await view(page);
    const mapPt = { x: (900 - before.x) / before.k, y: (500 - before.y) / before.k };
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(40);
    const mid = await view(page);
    await page.waitForTimeout(600);
    const after = await view(page);
    const ratio = after.k / before.k;
    assert.ok(ratio > 1.08 && ratio < 1.2, 'шаг колеса ' + ratio);
    assert.ok(mid.k > before.k && mid.k < after.k, `масштаб меняется плавно: ${before.k} ${mid.k} ${after.k}`);
    const sx = mapPt.x * after.k + after.x, sy = mapPt.y * after.k + after.y;
    assert.ok(Math.abs(sx - 900) < 1 && Math.abs(sy - 500) < 1, 'точка под курсором сдвинулась');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__geo.map.svg.style.transform), '', 'карта не перерисовалась начисто');
  });

  await step('перемещение правой и средней кнопкой мыши (без ответа)', async () => {
    const q = await current(page);
    for (const button of ['right', 'middle']) {
      const v0 = await view(page);
      await page.mouse.move(600, 500);
      await page.mouse.down({ button });
      await page.mouse.move(700, 560, { steps: 6 });
      await page.mouse.up({ button });
      const v1 = await view(page);
      assert.ok(Math.abs(v1.x - v0.x - 100) < 4 && Math.abs(v1.y - v0.y - 60) < 4, button + ': ' + JSON.stringify([v0, v1]));
    }
    const p = await pointOf(page, q.iso === '276' ? '250' : '276');
    await page.mouse.click(p.x, p.y, { button: 'right' });
    assert.equal((await current(page)).index, q.index);
    assert.doesNotMatch(await page.getAttribute('#feedback', 'class'), /show/);
  });

  await step('пауза останавливает таймер и автопереход', async () => {
    const q = await current(page);
    const wrong = await pointOf(page, q.iso === '276' ? '250' : '276');
    await page.mouse.click(wrong.x, wrong.y);
    await page.keyboard.press('p');
    assert.ok(await page.isVisible('#pause'));
    const t0 = await page.textContent('#timer');
    await page.waitForTimeout(3300);
    assert.equal((await current(page)).index, q.index, 'на паузе переход не должен случиться');
    assert.equal(await page.textContent('#timer'), t0, 'таймер должен стоять');
    await shot(page, '05-pause');
    await page.click('#pause-resume');
    assert.ok(await page.isHidden('#pause'));
    await page.waitForTimeout(3000);
    assert.equal((await current(page)).index, q.index + 1, 'после паузы автопереход продолжается');
  });

  await step('выход из теста с подтверждением', async () => {
    await page.click('#btn-exit');
    assert.ok(await page.isVisible('#confirm'));
    await page.keyboard.press('Escape');
    assert.ok(await page.isHidden('#confirm'));
    await page.click('#btn-exit');
    await page.click('#confirm-yes');
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'menu');
  });

  await step('режим «Столицы»: 4 варианта, клавиши 1–4, ошибки в результате', async () => {
    await page.click('#mode-seg [data-value="capitals"]');
    await page.click('#region-seg [data-value="all"]');
    await page.click('#btn-start');
    await page.waitForTimeout(800);
    const wrongAt = new Set([1, 4, 30, 89]);
    const expectedMistakes = [];
    for (let i = 0; i < 90; i++) {
      const q = await current(page);
      const qText = await page.textContent('#question');
      assert.ok(qText.startsWith('Столица ') && qText.endsWith('?'), qText);
      assert.equal(await page.locator('#options .option').count(), 4);
      assert.equal(await page.locator(`path.country[data-iso="${q.iso}"].is-target`).count(), 1);
      let idx = q.options.indexOf(q.capital);
      if (wrongAt.has(i)) { idx = (idx + 1) % 4; expectedMistakes.push(q.name); }
      if (i === 2) { await page.waitForTimeout(700); await shot(page, '06-capitals-question'); }
      await page.keyboard.press(String(idx + 1));
      const fb = await page.getAttribute('#feedback', 'class');
      assert.ok(fb.includes(wrongAt.has(i) ? 'bad' : 'ok'), q.name + ' ' + fb);
      assert.equal(await page.locator('#options .option.correct span:last-child').textContent(), q.capital);
      assert.ok((await page.textContent('#fb-text')).includes(q.capital));
      if (i === 1) { await page.waitForTimeout(500); await shot(page, '07-capitals-wrong'); }
      await page.click('#btn-next');
    }
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'result');
    assert.equal(await page.textContent('#res-score'), '86 из 90');
    assert.deepEqual(await page.locator('.mistake b').allTextContents(), expectedMistakes);
    await page.click('.mistake:nth-child(2)');
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.labels .label').count(), 2);
    await shot(page, '08-capitals-result');
  });

  await step('работа над ошибками запускает только ошибочные страны', async () => {
    await page.click('#btn-fix');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#q-total'), '4');
    assert.match(await page.textContent('#q-kicker'), /Работа над ошибками/);
  });

  await step('статистика сохраняется в localStorage и переживает перезагрузку', async () => {
    const s = JSON.parse(await page.evaluate(() => localStorage.getItem('geodictant.stats.v1')));
    assert.equal(s.games, 2);
    assert.equal(s.settings.mode, 'capitals');
    assert.equal(s.best['map:all'].score, 90);
    assert.equal(s.best['capitals:all'].score, 86);
    assert.equal(s.lastMistakes.isos.length, 4);
    await page.reload();
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'menu');
    assert.equal(await page.getAttribute('#mode-seg [data-value="capitals"]', 'aria-checked'), 'true');
    assert.ok(await page.isVisible('#btn-mistakes'));
    assert.match(await page.textContent('#btn-mistakes'), /4/);
    assert.match(await page.textContent('#stats'), /86 из 90/);
    assert.ok(await page.isVisible('#btn-weak'));
    await shot(page, '09-menu-stats');
    await page.click('#btn-mistakes');
    assert.equal(await page.textContent('#q-total'), '4');
    await page.click('#btn-exit');
  });

  await step('атлас: подсказка при наведении и подпись по клику', async () => {
    await page.click('#btn-study');
    await page.waitForTimeout(800);
    const p = await pointOf(page, '040');
    await page.mouse.move(p.x, p.y);
    await page.mouse.move(p.x + 1, p.y + 1);
    assert.ok(await page.isVisible('#tooltip'));
    assert.match(await page.textContent('#tooltip'), /Австрия.*Вена/);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.labels .label').count(), 2);
    await shot(page, '10-study');
    await page.keyboard.press('Escape');
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'menu');
  });

  await step('режим «Страны + столицы»: клик по стране, затем выбор столицы', async () => {
    await page.click('#mode-seg [data-value="combo"]');
    await page.click('#region-seg [data-value="oceania"]');
    await page.click('#btn-start');
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i++) {
      const q = await current(page);
      assert.equal(q.stage, 'place');
      assert.match(await page.textContent('#question'), /^Где наход/);
      assert.ok(await page.isHidden('#options'));
      const wrongPlace = i === 1;
      const target = wrongPlace ? (q.iso === '036' ? '554' : '036') : q.iso;
      const p = await pointOf(page, target);
      await page.mouse.click(p.x, p.y);
      const q2 = await current(page);
      assert.equal(q2.stage, 'capital', 'после клика должны появиться варианты столиц');
      assert.equal(q2.index, i);
      assert.match(await page.textContent('#question'), /^Столица /);
      assert.equal(await page.locator('#options .option').count(), 4);
      assert.ok(await page.isHidden('#btn-next'), 'до ответа о столице «Далее» нет');
      if (i === 1) { await page.waitForTimeout(400); await shot(page, '11-combo-capital'); }
      const wrongCap = i === 2;
      let idx = q2.options.indexOf(q2.capital);
      if (wrongCap) idx = (idx + 1) % 4;
      await page.keyboard.press(String(idx + 1));
      assert.ok(await page.isVisible('#btn-next'));
      assert.match(await page.getAttribute('#feedback', 'class'), wrongPlace || wrongCap ? /bad/ : /ok/);
      await page.click('#btn-next');
    }
    await page.waitForTimeout(300);
    assert.equal(await page.getAttribute('#app', 'data-screen'), 'result');
    assert.equal(await page.textContent('#res-score'), '8 из 10');
    assert.equal(await page.locator('.mistake').count(), 2);
    assert.match(await page.textContent('#mistake-list'), /Место на карте/);
    assert.match(await page.textContent('#mistake-list'), /Столица:/);
    await shot(page, '12-combo-result');
  });

  await step('режим «Без подсветки»: карта не закрашивает ответы', async () => {
    await page.click('#btn-menu');
    await page.click('#mode-seg [data-value="map"]');
    await page.click('#hl-seg [data-value="off"]');
    await page.click('#btn-start');
    await page.waitForTimeout(500);
    assert.equal(await page.getAttribute('#app', 'data-highlight'), 'off');
    const q = await current(page);
    const p = await pointOf(page, q.iso === '036' ? '554' : '036');
    await page.mouse.click(p.x, p.y);
    assert.match(await page.getAttribute('#feedback', 'class'), /bad/);
    const marked = await page.locator('.country.is-bad, .country.is-ok, .country.is-reveal, .country.is-wrong, .labels .label').count();
    assert.equal(marked, 0, 'на карте не должно быть отметок');
    await page.click('#btn-next');
    const q2 = await current(page);
    const p2 = await pointOf(page, q2.iso);
    await page.mouse.click(p2.x, p2.y);
    assert.match(await page.getAttribute('#feedback', 'class'), /ok/);
    assert.equal(await page.locator('.country.is-ok').count(), 0);
    await shot(page, '13-no-highlight');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('geodictant.stats.v1')).settings.highlight), false);
    await page.keyboard.press('Escape');
    await page.click('#confirm-yes');
    await page.click('#hl-seg [data-value="on"]');
  });

  await step('«Столицы» → ввод с клавиатуры: верно, опечатка, ошибка, «Не знаю»', async () => {
    await page.click('#btn-menu').catch(() => {});
    await page.click('#mode-seg [data-value="capitals"]');
    assert.ok(await page.isVisible('#variant-field'));
    await page.click('#variant-seg [data-value="input"]');
    await page.click('#region-seg [data-value="europe"]');
    await page.click('#btn-start');
    await page.waitForTimeout(500);
    assert.equal((await current(page)).stage, 'input');
    assert.ok(await page.isVisible('#answer-input'));
    assert.ok(await page.isHidden('#options'));
    // 1) верно, через Enter; поле в фокусе само
    let q = await current(page);
    await page.keyboard.type(q.capital.toLowerCase());
    await page.keyboard.press('Enter');
    assert.match(await page.getAttribute('#feedback', 'class'), /ok/);
    assert.match(await page.getAttribute('#answer-form', 'class'), /ok/);
    await page.keyboard.press('Enter');                 // Enter после ответа — следующий вопрос
    assert.equal((await current(page)).index, 1);
    // 2) опечатка (лишняя буква) — засчитано с пометкой
    q = await current(page);
    const long = q.capital.length >= 5;
    await page.fill('#answer-input', long ? q.capital + 'а' : q.capital);
    await page.click('#btn-answer');
    assert.match(await page.getAttribute('#feedback', 'class'), /ok/);
    if (long) assert.match(await page.textContent('#fb-text'), /опечатк/);
    await page.click('#btn-next');
    // 3) ошибка
    q = await current(page);
    await page.fill('#answer-input', 'Абракадабра');
    await page.keyboard.press('Enter');
    assert.match(await page.getAttribute('#feedback', 'class'), /bad/);
    assert.ok((await page.textContent('#fb-text')).includes(q.capital));
    await page.waitForTimeout(300);
    await shot(page, '30-input-wrong');
    await page.click('#btn-next');
    // 4) «Не знаю»
    await page.click('#btn-input-skip');
    assert.match(await page.getAttribute('#feedback', 'class'), /bad/);
    await page.click('#btn-next');
    assert.equal(await page.textContent('#score'), '2');
  });

  await step('«Знаю»: столица убирается из теста и больше не спрашивается', async () => {
    const q = await current(page);
    const total = Number(await page.textContent('#q-total'));
    assert.ok(await page.isVisible('#btn-known'));
    await page.click('#btn-known');
    assert.ok(await page.isVisible('#toast'));
    assert.equal(Number(await page.textContent('#q-total')), total - 1);
    assert.notEqual((await current(page)).iso, q.iso);
    assert.equal(await page.textContent('#score'), '2', 'счёт не меняется');
    const known = await page.evaluate(() => JSON.parse(localStorage.getItem('geodictant.stats.v1')).known);
    assert.deepEqual(known, [q.iso]);
    // Клавиша K (вне поля ввода)
    await page.evaluate(() => document.activeElement.blur());
    const q2 = await current(page);
    await page.keyboard.press('k');
    assert.equal(Number(await page.textContent('#q-total')), total - 2);
    await page.keyboard.press('Escape');
    await page.click('#confirm-yes');
    assert.match(await page.textContent('#start-hint'), /37 стран \(2 известны\)/);
    assert.match(await page.textContent('#btn-known-list'), /2/);
    // Новая игра не содержит известных
    await page.click('#btn-start');
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#q-total'), '37');
    const isos = await page.evaluate(() => window.__geo.state.session.questions.map((x) => x.country.iso));
    assert.ok(!isos.includes(q.iso) && !isos.includes(q2.iso));
    await page.click('#btn-exit');
    await page.click('#confirm-yes').catch(() => {});
    // Окно списка: снять отметку
    await page.click('#btn-known-list');
    assert.ok(await page.isVisible('#known-modal'));
    assert.equal(await page.locator('#known-list input:checked').count(), 2);
    await shot(page, '31-known-list');
    await page.uncheck(`#known-list input[data-iso="${q.iso}"]`);
    await page.click('#known-done');
    assert.match(await page.textContent('#start-hint'), /38 стран \(1 известна\)/);
    await page.click('#btn-known-list');
    await page.click('#known-clear');
    await page.click('#known-done');
    assert.match(await page.textContent('#start-hint'), /^· 39 стран$/);
  });

  await step('«Чья это столица?»: показывается столица, отвечаем кликом по стране', async () => {
    await page.click('#variant-seg [data-value="reverse"]');
    await page.click('#region-seg [data-value="oceania"]');
    await page.click('#btn-start');
    await page.waitForTimeout(500);
    for (let i = 0; i < 5; i++) {
      const q = await current(page);
      assert.equal(q.stage, 'place');
      const text = await page.textContent('#question');
      assert.equal(text, q.capital + ' — столица какой страны?');
      assert.equal(await page.locator('.country.is-target').count(), 0, 'страна не должна подсказываться');
      const wrong = i === 0;
      const p = await pointOf(page, wrong ? (q.iso === '036' ? '554' : '036') : q.iso);
      await page.mouse.click(p.x, p.y);
      assert.match(await page.getAttribute('#feedback', 'class'), wrong ? /bad/ : /ok/);
      assert.equal(await page.locator('.labels .label-capital').count(), 1);
      if (i === 0) { await page.waitForTimeout(400); await shot(page, '32-reverse-wrong'); }
      await page.click('#btn-next');
    }
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#res-score'), '4 из 5');
    assert.match(await page.textContent('#result-kicker'), /чья столица/);
    const best = await page.evaluate(() => JSON.parse(localStorage.getItem('geodictant.stats.v1')).best);
    assert.ok(best['capitals-reverse:oceania'], 'рекорд хранится отдельно для варианта');
    await page.click('#btn-menu');
    await page.click('#variant-seg [data-value="choice"]');
  });

  await step('части Азии: выбор группы в меню, тест только по ней', async () => {
    assert.ok(await page.isHidden('#asia-seg'));
    await page.click('#region-seg [data-value="asia"]');
    assert.ok(await page.isVisible('#asia-seg'));
    assert.equal(await page.locator('#asia-seg [role="radio"]').count(), 8);
    await page.click('#asia-seg [data-value="asia-central"]');
    assert.equal(await page.getAttribute('#region-seg [data-value="asia"]', 'aria-checked'), 'true');
    assert.match(await page.textContent('#start-hint'), /^· 5 стран$/);
    await page.waitForTimeout(800);
    await shot(page, '40-asia-groups');
    // Повторный клик по «Азии» не сбрасывает выбранную группу
    await page.click('#region-seg [data-value="asia"]');
    assert.equal(await page.getAttribute('#asia-seg [data-value="asia-central"]', 'aria-checked'), 'true');
    await page.click('#btn-start');
    await page.waitForTimeout(500);
    assert.equal(await page.textContent('#q-total'), '5');
    assert.match(await page.textContent('#q-kicker'), /Средняя Азия/);
    assert.equal(await page.locator('path.country:not(.is-inactive)').count(), 5);
    for (let i = 0; i < 5; i++) {
      const q = await current(page);
      await page.keyboard.press(String(q.options.indexOf(q.capital) + 1));
      await page.click('#btn-next');
    }
    await page.waitForTimeout(300);
    assert.equal(await page.textContent('#res-score'), '5 из 5');
    assert.match(await page.textContent('#result-kicker'), /Средняя Азия/);
    const best = await page.evaluate(() => JSON.parse(localStorage.getItem('geodictant.stats.v1')).best);
    assert.ok(best['capitals:asia-central']);
    // Выбор сохраняется после перезагрузки
    await page.reload();
    await page.waitForTimeout(400);
    assert.equal(await page.getAttribute('#asia-seg [data-value="asia-central"]', 'aria-checked'), 'true');
    await page.click('#asia-seg [data-value="asia"]');
    assert.match(await page.textContent('#start-hint'), /^· 46 стран$/);
    await page.click('#region-seg [data-value="europe"]');
    assert.ok(await page.isHidden('#asia-seg'));
  });

  await step('нет ошибок JavaScript', async () => {
    assert.deepEqual(errors, []);
  });

  // ----- Телефон -----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => errors.push(e.message));
  await mp.goto(URL);
  await mp.waitForTimeout(600);

  await step('телефон: меню, игра по тапу, варианты 2×2', async () => {
    await shot(mp, '20-mobile-menu');
    await mp.tap('#mode-seg [data-value="map"]');
    await mp.tap('#region-seg [data-value="asia"]');
    await mp.tap('#btn-start');
    await mp.waitForTimeout(700);
    await shot(mp, '21-mobile-game');
    const q = await current(mp);
    const p = await pointOf(mp, q.iso);
    assert.ok(p);
    await mp.touchscreen.tap(p.x, p.y);
    assert.match(await mp.getAttribute('#feedback', 'class'), /ok/);
    await mp.waitForTimeout(400);
    await shot(mp, '22-mobile-correct');
    const overflow = await mp.evaluate(() => Array.from(document.querySelectorAll('.hud, .question-card, .options, .skip-btn'))
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -1 || r.right > innerWidth + 1); }).map((e) => e.className));
    assert.deepEqual(overflow, []);
    await mp.tap('#btn-exit');
    await mp.tap('#confirm-yes');
    await mp.tap('#mode-seg [data-value="combo"]');
    await mp.tap('#btn-start');
    await mp.waitForTimeout(700);
    const q2 = await current(mp);
    const p2 = await pointOf(mp, q2.iso);
    await mp.touchscreen.tap(p2.x, p2.y);
    await mp.waitForTimeout(300);
    const cols = await mp.evaluate(() => getComputedStyle(document.getElementById('options')).gridTemplateColumns.split(' ').length);
    assert.equal(cols, 2);
    await shot(mp, '23-mobile-combo');
    await mp.tap(`#options .option:nth-child(${q2.options.indexOf(q2.capital) + 1})`);
    assert.match(await mp.getAttribute('#feedback', 'class'), /ok/);
  });

  await step('телефон: щипок меняет масштаб', async () => {
    await mp.waitForTimeout(300);
    const before = (await view(mp)).k;
    const cdp = await mctx.newCDPSession(mp);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
    await touch('touchStart', [[170, 450], [220, 450]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[170 - i * 15, 450], [220 + i * 15, 450]]);
    await touch('touchEnd', []);
    await mp.waitForTimeout(300);
    const after = (await view(mp)).k;
    assert.ok(after > before * 1.5, `pinch ${before} -> ${after}`);
  });

  await browser.close();
  const failed = results.filter((r) => r[0] === 'fail');
  console.log(`\n${results.length - failed.length} пройдено, ${failed.length} провалено`);
  process.exit(failed.length ? 1 : 0);
})();
