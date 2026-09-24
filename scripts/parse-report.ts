/**
 * CLI: парсит всю базу Wahapedia и печатает отчёт о качестве разбора.
 *
 *   npm run parse:report                          — сводка в консоль
 *   node scripts/parse-report.ts --json=r.json    — отчёт в файл
 *   node scripts/parse-report.ts --units=u.json   — все юниты в файл
 *   node scripts/parse-report.ts --by-id=000000021 — дамп одного юнита
 *   node scripts/parse-report.ts C:/data/dir      — другая папка с CSV
 *
 * Отчёт — часть результата парсинга: по нему видно, какие строки опций не
 * распознались, какое оружие не сошлось с каталогом и какие даташиты
 * пропущены (и почему).
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fsSource } from '../src/data/raw/node-source.ts';
import { loadUnitsFromSource } from '../src/data/parse/units.ts';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const directory = positional.length > 0 ? resolve(positional[0]) : resolve('public/data/wahapedia');
const jsonOut = flagValue('json');
const unitsOut = flagValue('units');
const byId = flagValue('by-id');

const { units, byId: unitsById, report } = await loadUnitsFromSource(fsSource(directory));

console.log(`База: ${directory}`);
console.log('');

// === Файлы ===
console.log('=== Файлы ===');
for (const file of Object.values(report.files)) {
  const tail: string[] = [];
  if (file.missingColumns.length > 0) tail.push(`missing: ${file.missingColumns.join(', ')}`);
  if (file.extraColumns.length > 0) tail.push(`extra: ${file.extraColumns.join(', ')}`);
  if (file.error !== null) tail.push(`error: ${file.error}`);
  console.log(
    `  ${file.found ? 'OK' : 'FAIL'} ${file.filename}: строк ${file.rows}` +
      (tail.length > 0 ? `; ${tail.join('; ')}` : '')
  );
}

// === Даташиты ===
console.log('');
console.log('=== Даташиты ===');
console.log(`  всего: ${report.datasheets.total}, разобрано: ${report.datasheets.parsed}`);
for (const skip of report.datasheets.skipped) {
  console.log(`  пропущено [${skip.reason}]: ${skip.count} (${skip.examples.slice(0, 3).join(', ')})`);
}

// === Опции ===
console.log('');
console.log('=== Опции снаряжения ===');
console.log(
  `  всего: ${report.options.total}, распознано: ${report.options.parsed}, ` +
    `None: ${report.options.skippedNone}, НЕ распознано: ${report.options.unparsed}`
);
const families = Object.entries(report.options.byFamily).sort((a, b) => b[1] - a[1]);
console.log(`  семейства: ${families.map(([family, count]) => `${family}=${count}`).join(', ')}`);
for (const sample of report.options.unparsedSamples.slice(0, 15)) {
  console.log(`  FAIL [${sample.datasheetId}:${sample.line}] ${sample.reason}: ${sample.raw.slice(0, 120)}`);
}


// === Состав ===
console.log('');
console.log('=== Состав отряда ===');
console.log(`  аномальные строки: ${report.composition.anomalousLines}`);
console.log(`  не сопоставлено подписей: ${report.composition.unmatchedLabels.length}`);
for (const label of report.composition.unmatchedLabels.slice(0, 10)) {
  console.log(`  FAIL [${label.datasheetId}] ${label.label.slice(0, 110)}`);
}

// === Оружие ===
console.log('');
console.log('=== Оружие ===');
console.log(`  групп: ${report.weapons.groups}, профилей: ${report.weapons.profiles}`);
console.log(`  неизвестных способностей оружия: ${report.weapons.unknownKeywords.length}`);
console.log(`  имён из опций/loadout без группы в каталоге: ${report.weapons.unmatchedNames.length}`);
const seenNames = new Set<string>();
for (const weapon of report.weapons.unmatchedNames) {
  if (seenNames.has(weapon.name)) continue;
  seenNames.add(weapon.name);
  if (seenNames.size > 20) break;
  console.log(`  FAIL [${weapon.datasheetId}] ${weapon.name}`);
}

// === Способности ===
console.log('');
console.log('=== Способности ===');
console.log(
  `  всего: ${report.abilities.total}, нераспознанных id: ${report.abilities.unresolvedIds.length}`
);
for (const id of report.abilities.unresolvedIds.slice(0, 10)) {
  console.log(`  FAIL ${id}`);
}

// === Стоимости ===
console.log('');
console.log('=== Стоимости ===');
console.log(`  юнитов с аномалиями стоимости: ${report.costs.unitsWithAnomalies}`);
for (const anomaly of report.costs.anomalies.slice(0, 10)) {
  console.log(`  FAIL [${anomaly.datasheetId}:${anomaly.line}] ${anomaly.description}: ${anomaly.cost}`);
}

// === Комплектация ===
console.log('');
console.log('=== Базовая комплектация ===');
console.log(`  юнитов без распознанной комплектации: ${report.loadout.unitsWithoutBaseLoadout}`);
console.log(`  примеры: ${report.loadout.unitsWithoutBaseLoadoutSamples.slice(0, 8).join(', ')}`);
console.log(`  юнитов с предупреждениями: ${report.loadout.unitsWithWarnings}`);
for (const warning of report.loadout.warningSamples.slice(0, 10)) {
  console.log(`  WARN [${warning.datasheetId}] ${warning.warning.slice(0, 120)}`);
}

// === Покрытие ===
console.log('');
console.log('=== Покрытие ===');
const coverage = report.coverage;
console.log(`  юнитов с опциями: ${coverage.unitsWithOptions}`);
console.log(`  юнитов с несколькими группами моделей: ${coverage.unitsWithMultipleModelGroups}`);
console.log(`  юнитов с damaged-скобкой: ${coverage.unitsWithDamagedBracket}`);
console.log(`  юнитов с транспортом: ${coverage.unitsWithTransport}`);
console.log(`  юнитов со связями лидер/отряд: ${coverage.unitsWithLeaderLinks}`);
console.log(`  среднее опций на юнит: ${coverage.averageOptionsPerUnit.toFixed(2)}`);
console.log(`  среднее записей базовой комплектации: ${coverage.averageBaseLoadoutEntries.toFixed(2)}`);

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nОтчёт сохранён: ${jsonOut}`);
}
if (unitsOut !== null) {
  writeFileSync(unitsOut, JSON.stringify(units, null, 2), 'utf8');
  console.log(`Юниты сохранены: ${unitsOut} (${units.length} шт.)`);
}
if (byId !== null) {
  const unit = unitsById.get(byId);
  if (unit === undefined) {
    console.log(`\nЮнит ${byId} не найден среди разобранных.`);
  } else {
    writeFileSync(`${byId}.json`, JSON.stringify(unit, null, 2), 'utf8');
    console.log(`\nЮнит ${byId} сохранён: ${byId}.json`);
  }
}
