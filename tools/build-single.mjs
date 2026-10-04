/*
 * Сборка сайта в ОДИН файл geodiktant.html: стили, скрипты и карта — внутри.
 *
 * Зачем: если отправить другу только index.html (или открыть его прямо из
 * ZIP-архива, или с телефона из мессенджера), браузер не найдёт папки css/ и js/
 * и страница будет пустой. Один файл работает везде, где его можно открыть.
 *
 * Запуск:  cd tools && npm run single
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let html = read('index.html');

html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) =>
  '<style>\n' + read(href) + '\n</style>');

html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  // «</script» внутри кода закрыл бы тег раньше времени.
  const code = read(src).replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + code + '\n</script>';
});

if (/<script src=|<link rel="stylesheet"/.test(html)) throw new Error('Остались внешние файлы');

const out = path.join(root, 'geodiktant.html');
fs.writeFileSync(out, html);
console.log(`geodiktant.html: ${(html.length / 1024).toFixed(0)} KB`);
