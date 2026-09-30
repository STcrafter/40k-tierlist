/**
 * Проверка целостности styles.css.
 *
 * Почему это скрипт, а не «просто посмотреть в браузере»: незакрытая } в CSS
 * не является ошибкой для браузера. Правило, открытое и не закрытое, молча
 * объявляет все последующие правила вложенными (CSS Nesting), и они начинают
 * требовать предка, которого в разметке нет: `.status` без закрывающей скобки
 * превращал `table { … }` в `.status table { … }` — правило оставалось
 * валидным, консоль была чистой, а ~40% оформления (рамки таблицы, липкая
 * шапка, кнопки сортировки, хром диалога, вся мобильная ветка @media) просто
 * не применялось. Ни tsc, ни vite build, ни vitest этого не видят.
 *
 * Скрипт обходит файл посимвольно (пропуская комментарии и url(...), где
 * скобки — часть данных) и требует, чтобы каждое правило открывалось и
 * закрывалось на своём уровне: вложенным может быть только правило внутри
 * @media / @supports / @keyframes и подобных оболочек.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NESTABLE = /^@(media|supports|layer|container|scope|keyframes)/i;

// Путь можно переопределить аргументом — удобно проверять другие стили или
// вычитанную из истории версию, чтобы убедиться, что проверка не бутафорская.
const target = process.argv[2] ? fileURLToPath(new URL(process.argv[2], import.meta.url)) : fileURLToPath(new URL('../web/src/styles.css', import.meta.url));
const lines = readFileSync(target, 'utf8').split(/\r?\n/);
const stack = [];
const problems = [];
let inComment = false;

for (let i = 1; i <= lines.length; i++) {
  let line = lines[i - 1];
  if (inComment) {
    const end = line.indexOf('*/');
    if (end < 0) continue;
    inComment = false;
    line = line.slice(end + 2);
  }
  line = line.replace(/\/\*[\s\S]*?\*\//g, '');
  if (line.includes('/*')) {
    inComment = true;
    line = line.slice(0, line.indexOf('/*'));
  }
  const url = line.indexOf('url(');
  if (url >= 0) line = line.slice(0, url);

  for (const ch of line) {
    if (ch === '{') {
      const selector = (line.split('{')[0].trim() || '(пусто)').replace(/\s+/g, ' ');
      const parent = stack[stack.length - 1];
      if (parent && !NESTABLE.test(parent.selector)) {
        problems.push(
          `L${i}: «${selector}» вложено в «${parent.selector}» (открыто на L${parent.line}) — ` +
            `селектор станет «${parent.selector} ${selector}» и не совпадёт ни с чем`,
        );
      }
      stack.push({ selector, line: i });
    } else if (ch === '}') {
      if (!stack.length) problems.push(`L${i}: закрывающая } без открывающей — тело правила «уехало» наружу`);
      else stack.pop();
    }
  }
}

for (const open of stack) problems.push(`L${open.line}: правило «${open.selector}» так и не закрыто`);

if (problems.length) {
  console.error(`styles.css: ${problems.length} наруш.ений баланса блоков`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log('styles.css: баланс блоков чист');
