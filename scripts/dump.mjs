// Временный дамп диапазона строк файла (обход капризов вывода терминала).
import { readFileSync, writeFileSync } from 'node:fs';
const [file, from, to, out] = process.argv.slice(2);
const lines = readFileSync(file, 'utf8').split('\n');
const slice = lines.slice(Number(from) - 1, Number(to)).map((l, i) => `${Number(from) + i} | ${l}`);
writeFileSync(out ?? 'dump.txt', slice.join('\n'), 'utf8');
console.log(`wrote ${slice.length} lines`);
