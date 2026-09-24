/**
 * CLI: парсит базу BSData и печатает отчёт о качестве разбора.
 *
 *   node scripts/bsdata-report.ts                       — сводка
 *   node scripts/bsdata-report.ts --units               — список даташитов
 *   node scripts/bsdata-report.ts --datasheet=Boyz      — разбор одного даташита
 *   node scripts/bsdata-report.ts --json=bs.json        — отчёт в файл
 *   node scripts/bsdata-report.ts --json=bs.json --lean — без ростерных записей
 *   node scripts/bsdata-report.ts C:/path/to/wh40k-11e  — другая папка
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData } from '../src/bsdata/load.ts';
import { describeDatasheet, parseBsDatabase } from '../src/bsdata/units.ts';
import { sizeTiersOf } from '../src/bsdata/points.ts';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const directory = positional.length > 0 ? resolve(positional[0]) : resolve('public/BSData/wh40k-11e');
const jsonOut = flagValue('json');
const datasheetName = flagValue('datasheet');
const listUnits = argv.includes('--units');

const files = bsFilesFromDir(directory);
console.log(`База: ${directory}`);
console.log(`Файлов: ${files.length}`);

const started = Date.now();
const db = loadBsData(files);
const lean = argv.includes('--lean');
const { datasheets, byId, report } = parseBsDatabase(db, { roster: lean ? 'drop' : 'keep' });
const elapsed = Date.now() - started;

console.log(`Определений в индексе: ${db.definitionCount}`);
console.log(`Нерезолвленных ссылок: ${report.unresolvedLinks}`);
console.log(
  `Типы профилей: unit=${report.profileTypeIds.unit} ranged=${report.profileTypeIds.ranged} ` +
    `melee=${report.profileTypeIds.melee} abilities=${report.profileTypeIds.abilities}`
);
console.log('');

console.log('=== Даташиты ===');
console.log(`  каталогов: ${report.catalogues}, даташитов: ${report.datasheets} (за ${elapsed} мс)`);
console.log(`  пропущено без цены: ${report.skippedNoCost.length}`);
if (report.skippedNoCost.length > 0) {
  console.log(`    ${report.skippedNoCost.slice(0, 8).join(', ')}`);
}
console.log(`  пропущено без моделей: ${report.datasheetsWithoutModels.length}`);
if (report.datasheetsWithoutModels.length > 0) {
  console.log(`    ${report.datasheetsWithoutModels.slice(0, 8).join(', ')}`);
}

console.log('');
console.log('=== Фракции ===');
for (const [faction, count] of Object.entries(report.datasheetsByFaction)) {
  console.log(`  ${faction}: ${count}`);
}

console.log('');
console.log('=== Качество данных ===');
console.log(`  оружейных профилей: ${report.weapons}`);
console.log(`  записей снаряжения без боевого профиля: ${report.wargearWithoutProfile}`);
console.log(`  ростерных записей (Warlord/Enhancements/Crusade): ${report.rosterEntries}`);
console.log(`  даташитов без оружия: ${report.datasheetsWithoutWeapons.length}`);
if (report.datasheetsWithoutWeapons.length > 0) {
  console.log(`    ${report.datasheetsWithoutWeapons.slice(0, 12).join(', ')}`);
}
console.log(`  ценовых модификаторов с внешними условиями: ${report.uncertainCosts.length}`);
for (const uncertain of report.uncertainCosts.slice(0, 10)) {
  console.log(`  ! ${uncertain.name}: ${uncertain.description}`);
}

// Сколько даташитов имеют тиры цены за размер (мультиразмерные отряды).
const multiSize = datasheets.filter((datasheet) => sizeTiersOf(datasheet).length > 1);
console.log(`  даташитов с несколькими размерами: ${multiSize.length}`);

if (listUnits) {
  console.log('');
  console.log('=== Список даташитов ===');
  for (const datasheet of datasheets) {
    const tiers = sizeTiersOf(datasheet)
      .map((tier) => `${tier.models}=${tier.points}`)
      .join(' ');
    console.log(
      `${datasheet.faction} | ${datasheet.name} <${datasheet.kind}> | ${tiers || `${datasheet.cost.base}`}`
    );
  }
}

if (datasheetName !== null) {
  const found =
    byId.get(datasheetName) ??
    datasheets.find((datasheet) => datasheet.name.toLowerCase() === datasheetName.toLowerCase());
  console.log('');
  if (!found) {
    console.log(`Даташит "${datasheetName}" не найден.`);
  } else {
    console.log(`=== ${found.name} (${found.sourceFile}) ===`);
    for (const line of describeDatasheet(found)) console.log(line);
  }
}

if (jsonOut !== null) {
  const payload = JSON.stringify({ report, datasheets });
  writeFileSync(jsonOut, payload, 'utf8');
  console.log(`\nОтчёт сохранён: ${jsonOut} (${(payload.length / 1048576).toFixed(1)} МБ)`);
}