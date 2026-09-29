/**
 * Сборщик данных для веб-тирлиста.
 *
 * Считает метрики всех юнитов один раз и выгружает готовый JSON. Считать их в
 * браузере при загрузке слишком долго (~90 с), поэтому в JSON кладутся и «сырые»
 * метрики, и полный боевой профиль — второй нужен панели деталей, чтобы показать
 * состав отряда и оружие.
 *
 * Клиент ничего не досчитывает: нормы, Total, перцентили и тиры уже посчитаны
 * здесь. Один источник правды — иначе сайт и отчёты разойдутся.
 *
 *   npm run build:data
 *   node scripts/build-tierlist.ts --trials=40 --out=web/public/data/tierlist.json
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ARCHETYPES, archetypeOf } from '../src/combat/archetypes.ts';
import {
  rawScoreOf,
  type CombatMode,
  type TargetParadigm,
} from '../src/tier/scoring.ts';
import { INDEX_CELL_KEYS } from '../src/tier/columns.ts';
import { withOnceEffects } from '../src/manual/abilities.ts';
import { emptyParadigmGrid, prepareUnits, type AttachedPayload, type TrimmedRow } from './prepare-units.ts';
import type { ComboResult, SensitivityResult, TierJob, TierWorkerResult } from './tier-worker.ts';
import type { BsDatasheet } from '../src/bsdata/types.ts';
import type { CombatUnit } from '../src/combat/types.ts';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};
const hasFlag = (name: string): boolean => argv.includes(`--${name}`);

const bsDataDir = flagValue('bs-data') ?? 'public/BSData/wh40k-11e';
const distance = Number(flagValue('distance') ?? 12);
const outPath = resolve(flagValue('out') ?? 'web/public/data/tierlist.json');
const modes: CombatMode[] = ['ranged', 'melee', 'combined'];
const paradigms: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

/**
 * Пресет для повседневных правок: меньше прогонов и без sensitivity.
 *
 * Числа прогонов подобраны так, чтобы ранжирование оставалось тем же самым:
 * ранги устойчивы уже на 15 прогонах, а sensitivity (третий полный прогон
 * тирлиста) влияет только на один диагностический столбец. Полная сборка с
 * 40 прогонами остаётся для финальной выгрузки на сайт.
 */
const QUICK = hasFlag('quick');
const trials = Number(flagValue('trials') ?? (QUICK ? 15 : 40));
const skipSensitivity = hasFlag('skip-sensitivity') || QUICK;

/**
 * Число дочерних процессов.
 *
 * По умолчанию 6, а не по числу ядер: каждый процесс держит свою копию
 * разобранной BSData, и 12 копий на 16 ГБ начинают давить по памяти. 6 берёт
 * верхнюю границу для 12 комбинаций — длиннейшая задача и так определяет
 * финальное время.
 */
const jobs = Number(flagValue('jobs') ?? Math.min(6, cpus().length));

const started = Date.now();
const { prepared, leaders } = prepareUnits(bsDataDir);
console.log(
  `Пригодных юнитов: ${prepared.length}, лидеров: ${leaders.length} ` +
    `(${Date.now() - started} мс на подготовку)`
);
console.log(
  `Прогонов: ${trials}, воркеров: ${jobs}, sensitivity: ${skipSensitivity ? 'выключен' : 'включён'}` +
    `${QUICK ? ' (--quick)' : ''}`
);

console.log(`Эталоны целей: ${ARCHETYPES.length} (выведены из данных)`);
for (const archetype of ARCHETYPES) {
  console.log(
    `  ${archetype.id.padEnd(11)} ${archetype.name.padEnd(26)} n=${String(archetype.sample).padStart(4)} ` +
      `T${archetype.toughness} W${archetype.wounds} Sv${archetype.save ?? '-'} models=${archetype.models} ` +
      `pts=${archetype.points} [${archetype.group}]`
  );
}

const byParadigm = emptyParadigmGrid(paradigms, modes, () => [] as TrimmedRow[]);
const attachedByParadigm = emptyParadigmGrid(
  paradigms,
  modes,
  () => [] as AttachedPayload[]
);

/**
 * Дельты одноразовых способностей: «сколько стоит бафф» по урону и по живучести.
 *
 * Считается двумя прогонами по одним и тем же шаблонным целям: с
 * включёнными одноразовыми эффектами и без них. Разница и есть дельта.
 *
 * Выживаемость меряется отдельно от урона, и это не дублирование: способности
 * делятся на два класса, которые видны в разных величинах. Боевые (Trajann,
 * повторный залп Custodian Guard) проявляются в `rawMaxDamage`, а защитные
 * (Allarus-щит) — в `effectiveSurvivability`, и в сумме они дают полную картину
 * цены способности. Раньше считался только урон, поэтому Allarus-щит и Trajann
 * выглядели в отчёте одинаково пустыми, хотя стоят противоположного.
 *
 * Обе дельты — справочные: в тир и нормы они не попадают, потому что
 * «once per battle» не действует постоянно. У юнитов без таких способностей
 * (а их подавляющее большинство) прогоны не выполняются вовсе — иначе сборка
 * платила бы лишний Monte-Carlo на каждого юнита.
 */
interface OnceEffectDeltas {
  damage: number;
  survivability: number;
}

function onceEffectDeltasOf(
  datasheet: BsDatasheet,
  unit: CombatUnit,
  points: number
): OnceEffectDeltas {
  const boosted = withOnceEffects(unit);
  // Нет эффекта — тот же объект, дельты нулевые по построению.
  if (boosted === unit) return { damage: 0, survivability: 0 };

  const options = { mode: 'combined' as const, targetParadigm: 'all' as const };
  // Считается для единиц юнитов, но дельты — справочные величины: сбой
  // расчёта не должен ронять всю сборку тирлиста, поэтому перехватываем.
  try {
    const plain = rawScoreOf(datasheet, unit, points, options);
    const buffed = rawScoreOf(datasheet, boosted, points, options);
    const round2 = (value: number): number => Math.round(value * 100) / 100;
    return {
      damage: round2(buffed.rawMaxDamage - plain.rawMaxDamage),
      survivability: round2(buffed.effectiveSurvivability - plain.effectiveSurvivability),
    };
  } catch (error) {
    console.error(`  дельта не посчитана для «${datasheet.name}»:`, error);
    return { damage: 0, survivability: 0 };
  }
}

/**
 * Задачи раздаются воркерам по кругу.
 *
 * Порядок не влияет на результат: сиды Монте-Карло зависят только от юнита и
 * индекса цели (`(seed + index * 7919)`), а не от того, какой воркер и в каком
 * порядке считал. Поэтому распараллеливание не меняет ни одной цифры.
 */
function runPool(tasks: TierJob[]): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();
  const workerScript = fileURLToPath(new URL('./tier-worker.ts', import.meta.url));
  const shards: TierJob[][] = Array.from({ length: Math.min(jobs, tasks.length) }, () => []);
  tasks.forEach((task, index) => {
    shards[index % shards.length].push(task);
  });

  return new Promise<void>((resolveAll, rejectAll) => {
    let pending = shards.length;
    const failed = new Error('воркер сборки завершился с ошибкой');

    for (const [index, shard] of shards.entries()) {
      const args = [
        workerScript,
        `--jobs=${JSON.stringify(shard)}`,
        `--trials=${trials}`,
        `--distance=${distance}`,
        `--bs-data=${bsDataDir}`,
      ];
      const child = fork(workerScript, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

      child.on('message', (message: { preparedMs: number; result: TierWorkerResult }) => {
        if (message.preparedMs > 3000) {
          console.log(`  воркер ${index + 1}: подготовка ${message.preparedMs} мс`);
        }
        const result = message.result;
        if (result.kind === 'combo') {
          const combo = result as ComboResult;
          byParadigm[combo.paradigm][combo.mode] = combo.rows;
          attachedByParadigm[combo.paradigm][combo.mode] = combo.attached;
          console.log(
            `Парадигма ${combo.paradigm}/${combo.mode}: ${combo.rows.length} юнитов, ` +
              `${combo.attached.length} с лидерами (${combo.elapsedMs} мс, воркер ${index + 1})`
          );
          return;
        }
        const sensitivity = result as SensitivityResult;
        sensitivityEntries = new Map(sensitivity.entries);
        console.log(
          `Sensitivity (all/combined): HIGH у ${sensitivity.high} из ${sensitivity.size} юнитов ` +
            `(${sensitivity.elapsedMs} мс, воркер ${index + 1})`
        );
      });

      child.on('error', (error) => {
        failed.cause = error;
        rejectAll(error);
      });
      child.on('exit', (code) => {
        if (code !== 0) {
          rejectAll(failed);
          return;
        }
        pending -= 1;
        if (pending === 0) resolveAll();
      });
    }
  });
}

// Sensitivity — это третий полный прогон тирлиста, и он ни от чего не зависит,
// поэтому уходит в общий пул отдельной задачей, а не считается в конце.
let sensitivityEntries = new Map<
  string,
  { spread: number; high: boolean; medium: boolean; tierChangeProbability: number }
>();

const tasks: TierJob[] = paradigms.flatMap((paradigm) =>
  modes.map((mode) => ({ kind: 'combo', paradigm, mode } as TierJob))
);
if (!skipSensitivity) tasks.push({ kind: 'sensitivity' } as TierJob);

const poolStarted = Date.now();
await runPool(tasks);
console.log(`Расчёт завершён за ${((Date.now() - poolStarted) / 1000).toFixed(1)} с`);

const sensitivity = sensitivityEntries;

/**
 * Боевой профиль юнита для пересчёта на клиенте: модель целиком, чтобы
 * правка T/W/Sv и оружия пересчитывалась тем же кодом, что и на сервере.
 */
function unitProfileOf(unit: CombatUnit, points: number): unknown {
  return {
    id: unit.id,
    name: unit.name,
    points,
    keywords: unit.keywords,
    models: unit.models.map((model) => ({
      id: model.id,
      name: model.name,
      toughness: model.toughness,
      wounds: model.wounds,
      save: model.save,
      invuln: model.invuln,
      fnp: model.fnp,
      fnpScope: model.fnpScope,
      keywords: model.keywords,
      weapons: model.weapons.map((weapon) => ({
        id: weapon.id,
        name: weapon.name,
        kind: weapon.kind,
        range: weapon.range,
        attacks: weapon.attacks,
        skill: weapon.skill,
        strength: weapon.strength,
        ap: weapon.ap,
        damage: weapon.damage,
        keywords: weapon.keywords.map((k) => ({ name: k.name, raw: k.raw })),
      })),
    })),
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  trials,
  distance,
  modes,
  paradigms,
  factions: [...new Set(prepared.flatMap((item) => item.datasheet.factions))].sort(),
  units: prepared.map(({ datasheet, unit, points, loadouts }) => {
    const base = byParadigm.all.combined.find((row) => row.id === datasheet.id);
    const sensitivityRow = sensitivity.get(datasheet.id);
    const metricsFor = (paradigm: TargetParadigm, mode: CombatMode) => {
      const row = byParadigm[paradigm][mode].find((candidate) => candidate.id === datasheet.id);
      return {
        rawMaxDamage: row?.rawMaxDamage ?? 0,
        bestTarget: row?.bestTarget ?? 'infantry',
        bestTargetName: row?.bestTargetName ?? 'Пехота',
        destroyedPointsByTarget: row?.destroyedPointsByTarget ?? {},
        effectiveOffenseVector: row?.effectiveOffenseVector ?? {},
        defenseVector: row?.defenseVector ?? {},
        universal: row?.universal ?? 0,
        damagePer100: row?.damagePer100 ?? 0,
        absorbedPer100: row?.absorbedPer100 ?? 0,
        bulkPer100: row?.bulkPer100 ?? 0,
        censoredShare: row?.censoredShare ?? 0,
        unitType: row?.unitType ?? 'Ranged',
        taxDamage: row?.tax.damage ?? 1,
        taxSurvivability: row?.tax.survivability ?? 1,
        effectiveDamage: row?.effectiveDamage ?? 0,
        effectiveSurvivability: row?.effectiveSurvivability ?? 0,
        normDamage: row?.normDamage ?? 0,
        normSurvivability: row?.normSurvivability ?? 0,
        normUtility: row?.normUtility ?? 0,
        vectorDamageScore: row?.vectorDamageScore ?? 0,
        vectorSurvivabilityScore: row?.vectorSurvivabilityScore ?? 0,
        vectorDamageFloor: row?.vectorDamageFloor ?? 0,
        vectorSurvivabilityFloor: row?.vectorSurvivabilityFloor ?? 0,
        utilityFlags: row?.utilityFlags ?? [],
        utilityScore: row?.utilityScore ?? 0,
        totalScore: row?.totalScore ?? 0,
        percentile: row?.percentile ?? 50,
        tier: row?.tier ?? 'D',
      };
    };
    const metricsByParadigm = Object.fromEntries(
      paradigms.map((paradigm) => [paradigm, Object.fromEntries(modes.map((mode) => [mode, metricsFor(paradigm, mode)]))])
    ) as Record<TargetParadigm, Record<CombatMode, ReturnType<typeof metricsFor>>>;
    // Профили loadout остаются в JSON без числовых метрик: считать их для
    // тысяч юнитов дорого, а панели деталей достаточно состава и очков.
    const loadoutMetrics = loadouts.map((loadout) => ({
      id: loadout.id,
      name: loadout.name,
      points: loadout.points,
      unit: unitProfileOf(loadout.unit, loadout.points),
    }));
    return {
      id: datasheet.id,
      name: datasheet.name,
      faction: datasheet.faction,
      factions: datasheet.factions,
      points,
      models: unit.models.length,
      archetype: archetypeOf(unit, points)?.id ?? 'unknown',
      onceEffectDeltas: onceEffectDeltasOf(datasheet, unit, points),
      /**
       * Чувствительность ранга к размеру эталонных целей (±20% моделей).
       * Считается только для all/combined — это единственный вид, для которого
       * прогон делается; в остальных полях флаг не переносится.
       */
      sensitivity: {
        spread: sensitivityRow?.spread ?? 0,
        high: sensitivityRow?.high ?? false,
        medium: sensitivityRow?.medium ?? false,
        // Доля сценариев возмущения, в которых юнит сменил тир: это и есть
        // содержательная мера устойчивости (прежний порог в перцентилях
        // срабатывал у 83.8% набора и ничего не выделял).
        tierChangeProbability: sensitivityRow?.tierChangeProbability ?? 0,
      },
      utilityFlags: base?.utilityFlags ?? [],
      utilityScore: base?.utilityScore ?? 0,
      unit: unitProfileOf(unit, points),
      // Алиас `metrics: metricsByParadigm.all` больше не выгружается: это были
      // те же 4.58 МБ байт в байт, а читала их одна строка фолбэка на клиенте.
      metricsByParadigm,
      loadouts: loadoutMetrics,
    };
  }),
};

const leadersPayload = leaders.map((leader) => ({
  id: leader.id,
  name: leader.name,
  faction: leader.faction,
  factions: leader.factions,
  points: leader.points,
  keywords: leader.keywords,
  allowedUnitIds: leader.allowedUnitIds,
  bonuses: leader.bonuses,
  abilities: leader.abilities,
  unit: unitProfileOf(leader.unit, leader.points),
}));

const attachedPayload = Object.fromEntries(
  paradigms.map((paradigm) => [paradigm, attachedByParadigm[paradigm]])
);

/**
 * Ячейка индекса: те же имена полей, что в полной метрике.
 *
 * Ключи берутся из src/tier/columns.ts — того же модуля, который читает
 * таблица, — поэтому колонка не может остаться без данных, а тест
 * columns.test.ts следит за равенством с обеих сторон.
 */
function indexCell(full: Record<string, unknown>): Record<string, unknown> {
  const cell: Record<string, unknown> = {};
  for (const key of INDEX_CELL_KEYS) cell[key] = full[key];
  return cell;
}

const indexPayload = {
  generatedAt: payload.generatedAt,
  trials: payload.trials,
  distance: payload.distance,
  modes: payload.modes,
  paradigms: payload.paradigms,
  factions: payload.factions,
  leaders: leadersPayload,
  units: payload.units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    faction: unit.faction,
    factions: unit.factions,
    points: unit.points,
    models: unit.models,
    archetype: unit.archetype,
    onceEffectDeltas: unit.onceEffectDeltas,
    sensitivity: unit.sensitivity,
    utilityFlags: unit.utilityFlags,
    utilityScore: unit.utilityScore,
    cells: Object.fromEntries(
      paradigms.map((paradigm) => [
        paradigm,
        Object.fromEntries(
          modes.map((mode) => [mode, indexCell(unit.metricsByParadigm[paradigm][mode] as never)])
        ),
      ])
    ),
  })),
};

/**
 * Запись файла с отчётом о размере.
 *
 * Считается и несжатый размер: по нему видно, что именно разошлось по вкладкам,
 * а не по памяти браузера.
 */
function writeJson(path: string, value: unknown): number {
  mkdirSync(dirname(path), { recursive: true });
  // Сериализуем ОДИН раз: файл крупный (десятки МБ), а повторный JSON.stringify
  // держал бы в памяти вторую такую же строку и мог уронить процесс на записи.
  const json = JSON.stringify(value);
  writeFileSync(path, json, 'utf8');
  return json.length;
}

const unitsDir = resolve(dirname(outPath), 'units');
// Каталог пересобирается целиком: без чистки в нём копились бы файлы юнитов,
// которых больше нет в BSData (переименование id = новый id + старый остаётся).
rmSync(unitsDir, { recursive: true, force: true });
mkdirSync(unitsDir, { recursive: true });

const indexPath = outPath;
const indexBytes = writeJson(indexPath, indexPayload);

// Панель деталей. Один юнит — 11–27 КБ, поэтому она грузится по клику, а не
// вместе со всем набором.
let detailBytes = 0;
for (const unit of payload.units) {
  detailBytes += writeJson(resolve(unitsDir, `${unit.id}.json`), unit);
}

// Строки «юнит + лидер» нужны только во второй вкладке, а весят больше всех
// юнитов вместе взятых, поэтому тоже вынесены в отдельный файл.
const attachedPath = resolve(dirname(outPath), 'attached.json');
const attachedBytes = writeJson(attachedPath, {
  generatedAt: payload.generatedAt,
  attached: attachedPayload,
});

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nГотово за ${elapsed} с`);
console.log(`  ${indexPath} — ${mb(indexBytes)} МБ (загружается сразу)`);
console.log(`  ${attachedPath} — ${mb(attachedBytes)} МБ (вкладка «с лидерами»)`);
console.log(`  ${unitsDir}/ — ${mb(detailBytes)} МБ на ${payload.units.length} юнитов (по клику)`);
