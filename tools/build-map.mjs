/*
 * Сборка SVG-геометрии карты для тренажёра.
 *
 * Источник: Natural Earth 1:50m (пакет world-atlas, topojson).
 * Результат: ../js/map-data.js — готовые SVG-пути в координатах viewBox,
 * чтобы сайт открывался простым двойным кликом по index.html (без сервера).
 *
 * Запуск:  cd tools && npm install && npm run build
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as topojson from 'topojson-client';
import { geoPath, geoCentroid, geoArea, geoContains } from 'd3-geo';
import polygonClipping from 'polygon-clipping';
import { geoMiller } from 'd3-geo-projection';
import polylabel from 'polylabel';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { COUNTRIES } = require('../js/data.js');
const world = require('world-atlas/countries-50m.json');

// --- Проекция: Миллер, центр на 83° в.д., охват от Исландии до Чукотки и Фиджи.
const WIDTH = 2000;
const LON_CENTER = 83;
const LON_HALF = 111; // градусов в каждую сторону от центра
const LAT_TOP = 81;
const LAT_BOTTOM = -50;

const projection = geoMiller().rotate([-LON_CENTER, 0]).scale(1).translate([0, 0]);
const [x0] = projection([LON_CENTER - LON_HALF, 0]);
const [x1] = projection([LON_CENTER + LON_HALF, 0]);
const scale = WIDTH / (x1 - x0);
projection.scale(scale);
const yTop = projection([LON_CENTER, LAT_TOP])[1];
const yBottom = projection([LON_CENTER, LAT_BOTTOM])[1];
projection.translate([WIDTH / 2, -yTop]);
const HEIGHT = Math.round(yBottom - yTop);
projection.clipExtent([[0, 0], [WIDTH, HEIGHT]]);

const pathGen = geoPath(projection).digits(1);
const round1 = (v) => Math.round(v * 10) / 10;

const fc = topojson.feature(world, world.objects.countries);
// Один код может встречаться несколько раз (Австралия + о-ва Ашмор и Картье).
const byIso = new Map();
for (const f of fc.features) {
  if (!f.id) continue;
  if (!byIso.has(f.id)) byIso.set(f.id, []);
  byIso.get(f.id).push(f);
}

// Запорожская и Херсонская области, ДНР и ЛНР показываются в составе России
// (по правилам географического диктанта). Контуры областей — geoBoundaries (CC BY 4.0),
// внешнее побережье берётся из того же набора Natural Earth, что и остальная карта.
// polygon-clipping работает с плоскими координатами и отдаёт внешние контуры против
// часовой стрелки, а d3-geo ждёт обратного порядка — поэтому кольца разворачиваются.
const toD3 = (multi) => multi.map((poly) => poly.map((ring) => ring.slice().reverse()));
const fromD3 = (geom) => toD3(geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates);
{
  const regions = JSON.parse(fs.readFileSync(path.join(here, 'regions-to-russia.geojson'), 'utf8'));
  const regionsUnion = polygonClipping.union(...regions.features.map((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
  const ua = byIso.get('804')[0];
  const ru = byIso.get('643')[0];
  const uaPolys = fromD3(ua.geometry);
  const moved = polygonClipping.intersection(uaPolys, regionsUnion);
  const uaLeft = polygonClipping.difference(uaPolys, regionsUnion)
    // убираем крошечные «щепки» на стыке разных наборов данных
    .filter((poly) => geoArea({ type: 'Polygon', coordinates: toD3([poly])[0] }) > 1e-7);
  // Чукотка пересекает 180-й меридиан: для плоских операций переносим западные
  // долготы на +360°, чтобы контур России был непрерывным (d3-geo это понимает).
  const unwrap = (multi) => multi.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x < 0 ? x + 360 : x, y])));
  const ruNew = polygonClipping.union(unwrap(fromD3(ru.geometry)), moved);
  ua.geometry = { type: 'MultiPolygon', coordinates: toD3(uaLeft) };
  ru.geometry = { type: 'MultiPolygon', coordinates: toD3(ruNew) };
  // Самопроверка: города в пределах нужной страны.
  const check = {
    643: { 'Донецк': [37.80, 48.00], 'Луганск': [39.30, 48.57], 'Мелитополь': [35.37, 46.85],
      'Геническ': [34.81, 46.17], 'Херсон': [32.62, 46.64], 'Мариуполь': [37.55, 47.10], 'Севастополь': [33.52, 44.60] },
    804: { 'Киев': [30.52, 50.45], 'Харьков': [36.23, 49.99], 'Одесса': [30.73, 46.48], 'Днепр': [35.04, 48.46] }
  };
  for (const [iso, cities] of Object.entries(check)) {
    const f = iso === '643' ? ru : ua;
    for (const [name, pt] of Object.entries(cities)) {
      if (!geoContains(f, pt)) throw new Error(`${name} не попал в ${iso}`);
    }
  }
  for (const g of [ua.geometry, ru.geometry]) {
    for (const poly of g.coordinates) {
      if (geoArea({ type: 'Polygon', coordinates: poly }) > 2 * Math.PI) throw new Error('Неверная ориентация контура');
    }
  }
}

// Северный Кипр в наборе Natural Earth выделен отдельно — отдаём остров Кипру,
// чтобы по нему можно было кликнуть как по стране из списка.
const nCyprus = fc.features.find((f) => f.properties.name === 'N. Cyprus');
const usedFeatures = new Set();

function polygonsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}

// Заморские территории Франции (Реюньон, Майотта и т. п.) не относятся
// к вопросу «Где находится Франция?» — они уходят в фоновый слой.
function isOverseas(iso, poly) {
  if (iso !== '250') return false;
  const [lon, lat] = geoCentroid({ type: 'Polygon', coordinates: poly });
  return !(lon > -10 && lon < 15 && lat > 40 && lat < 52);
}

/* Проецирует полигон и ищет внутри него самую «глубокую» точку. */
function innerPoint(poly) {
  const rings = [];
  const ctx = {
    ring: null,
    moveTo(x, y) { this.ring = [[x, y]]; rings.push(this.ring); },
    lineTo(x, y) { this.ring.push([x, y]); },
    closePath() {},
    arc() {}
  };
  geoPath(projection, ctx)(poly);
  if (!rings.length) return pathGen.centroid(poly);
  // Внешний контур — самый большой по площади, остальные считаем дырами.
  const area = (r) => Math.abs(r.reduce((s, p, i) => {
    const q = r[(i + 1) % r.length];
    return s + p[0] * q[1] - q[0] * p[1];
  }, 0) / 2);
  rings.sort((a, b) => area(b) - area(a));
  const p = polylabel(rings, 0.1);
  return [p[0], p[1]];
}

const background = [];
const countriesOut = {};

for (const c of COUNTRIES) {
  const feats = byIso.get(c.iso);
  if (!feats) throw new Error(`Нет геометрии для ${c.name} (${c.iso})`);
  let polys = [];
  for (const f of feats) {
    usedFeatures.add(f);
    polys = polys.concat(polygonsOf(f.geometry));
  }
  if (c.iso === '196' && nCyprus) {
    polys = polys.concat(polygonsOf(nCyprus.geometry));
    usedFeatures.add(nCyprus);
  }
  const own = [];
  for (const p of polys) {
    if (isOverseas(c.iso, p)) background.push(p);
    else own.push(p);
  }
  const geom = { type: 'MultiPolygon', coordinates: own };
  const d = pathGen(geom);
  if (!d) throw new Error(`Пустой путь для ${c.name}`);

  // Главные части страны: полигоны площадью ≥ 5% крупнейшего — для рамки приближения.
  const parts = own
    .map((p) => {
      const g = { type: 'Polygon', coordinates: p };
      return { g, area: pathGen.area(g) };
    })
    .filter((p) => p.area > 0)
    .sort((a, b) => b.area - a.area);
  if (!parts.length) throw new Error(`Страна вне карты: ${c.name}`);
  const main = parts.filter((p) => p.area >= parts[0].area * 0.05);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const p of main) {
    const [[a, b], [cc, dd]] = pathGen.bounds(p.g);
    bx0 = Math.min(bx0, a); by0 = Math.min(by0, b);
    bx1 = Math.max(bx1, cc); by1 = Math.max(by1, dd);
  }
  // Точка для подписи и кружка-мишени: «полюс недоступности» крупнейшей части —
  // в отличие от центроида, он всегда внутри страны (важно для Хорватии и т. п.).
  const labelPoint = innerPoint(parts[0].g);
  const capital = projection(c.cap);
  const totalArea = parts.reduce((s, p) => s + p.area, 0);

  countriesOut[c.iso] = {
    d,
    box: [bx0, by0, bx1, by1].map(round1),
    c: labelPoint.map(round1),
    cap: capital.map(round1),
    area: round1(totalArea)
  };
}

// Америку и Гренландию не рисуем: они не относятся к теме и обрезались бы краем карты.
const isAmericas = (f) => {
  const [lon] = geoCentroid(f);
  return lon < -25 && lon > -180;
};
for (const f of fc.features) {
  if (usedFeatures.has(f) || isAmericas(f)) continue;
  for (const p of polygonsOf(f.geometry)) background.push(p);
}
// Фон — отдельные пути по странам, чтобы были видны их границы.
const bgPaths = [];
for (const p of background) {
  const d = pathGen({ type: 'Polygon', coordinates: p });
  if (d) bgPaths.push(d);
}

const out = {
  width: WIDTH,
  height: HEIGHT,
  source: 'Natural Earth 1:50m via world-atlas',
  countries: countriesOut,
  background: bgPaths.join('')
};

const js =
  '/* Сгенерировано tools/build-map.mjs — не редактировать вручную. */\n' +
  'window.MAP_DATA = ' + JSON.stringify(out) + ';\n';
const target = path.join(here, '..', 'js', 'map-data.js');
fs.writeFileSync(target, js);
console.log(`map-data.js: ${(js.length / 1024).toFixed(0)} KB, viewBox ${WIDTH}x${HEIGHT}, стран: ${Object.keys(countriesOut).length}`);
const small = Object.entries(countriesOut)
  .filter(([, v]) => v.area < 40)
  .map(([k, v]) => `${COUNTRIES.find((c) => c.iso === k).name}:${v.area}`);
console.log('Мелкие страны:', small.join(', '));
