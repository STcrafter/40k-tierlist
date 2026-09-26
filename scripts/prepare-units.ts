/**
 * Общая подготовка данных для сборки тирлиста.
 *
 * Вынесено отдельно, потому что после распараллеливания одну и ту же подготовку
 * выполняют и главный процесс, и дочерние воркеры. Дублировать разбор BSData и
 * правила подбора лидеров в двух местах нельзя: расхождение дало бы разные
 * цифры в зависимости от того, кто считал.
 *
 * Здесь же — обрезка строк тирлиста до полей, которые реально попадают в JSON.
 * Раньше полные TierRow жили в памяти главного процесса сразу для всех 12
 * комбинаций; теперь они пересылаются по IPC, поэтому лишние поля убираются на
 * стороне воркера.
 */

import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit, loadoutVariantsOf, type LoadoutCandidate } from '../src/combat/adapter.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { leaderDefinitionsOf, type LeaderDefinition } from '../src/tier/leaders.ts';
import type { BsDatasheet } from '../src/bsdata/types.ts';
import type { CombatUnit } from '../src/combat/types.ts';
import type { TierRow } from '../src/tier/scoring.ts';
import type { UtilityFlag } from '../src/tier/utility.ts';

export interface PreparedUnit {
  datasheet: BsDatasheet;
  unit: CombatUnit;
  points: number;
  loadouts: LoadoutCandidate[];
}

/** Пара «юнит + присоединённый лидер» для отдельной вкладки тирлиста. */
export interface AttachedEntry {
  datasheet: BsDatasheet;
  unit: CombatUnit;
  points: number;
  leader: LeaderDefinition;
  rowId: string;
  faction: string;
  factions: string[];
}

/**
 * Разбор базы и отбор пригодных юнитов. Вызывается и в главном процессе, и в
 * каждом воркере, поэтому возвращаемое состояние самодостаточно.
 */
export function prepareUnits(bsDataDir: string): {
  prepared: PreparedUnit[];
  leaders: LeaderDefinition[];
} {
  const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir(bsDataDir)));
  const prepared: PreparedUnit[] = [];
  for (const datasheet of datasheets) {
    const adapted = adaptUnit(datasheet, { size: 'min' });
    if (
      adapted.unit.models.length === 0 ||
      !isEligibleForCalculations(datasheet.name, adapted.points)
    ) {
      continue;
    }
    const loadouts = loadoutVariantsOf(datasheet, { size: 'min', limit: 4 });
    prepared.push({ datasheet, unit: adapted.unit, points: adapted.points, loadouts });
  }
  const leaders = leaderDefinitionsOf(datasheets);
  if (leaders.length === 0) {
    throw new Error('BSData: не найдено ни одного Leader/Support с допустимыми отрядами');
  }
  return { prepared, leaders };
}

/** Общий Astartes-юнит принадлежит каждому чаптеру через factions, а не через одну строку faction. */
function sharesFaction(unit: BsDatasheet, leader: { factions: string[] }): boolean {
  return leader.factions.some((faction) => unit.factions.includes(faction));
}

/**
 * Все разрешённые пары «юнит + лидер».
 *
 * В BSData один отряд может принимать несколько Leader/Support, и сохраняется
 * каждая пара, которую явно разрешает локальная база: это отдельная вкладка, и
 * искусственно выбирать одного лидера здесь не нужно.
 */
export function attachedEntriesOf(
  prepared: PreparedUnit[],
  leaders: LeaderDefinition[]
): AttachedEntry[] {
  return prepared.flatMap(({ datasheet, unit, points }) => {
    const candidates = leaders
      .filter((leader) => sharesFaction(datasheet, leader))
      .filter((leader) => leader.allowedUnitIds.includes(datasheet.id))
      .filter((leader) => points + leader.points <= 2000);
    return candidates.map((leader) => ({
      datasheet,
      unit,
      points,
      leader,
      rowId: `${datasheet.id}+${leader.id}`,
      faction: leader.faction,
      factions: [...new Set([...datasheet.factions, ...leader.factions])],
    }));
  });
}

/** Фракции пары «юнит + лидер» — нужен обратный разбор по id строки. */
export function pairFactionsOf(
  rowId: string,
  prepared: PreparedUnit[],
  leaders: LeaderDefinition[]
): string[] {
  const [unitId, leaderId] = rowId.split('+');
  const unit = prepared.find((item) => item.datasheet.id === unitId)?.datasheet;
  const leader = leaders.find((item) => item.id === leaderId);
  return [...new Set([...(unit?.factions ?? []), ...(leader?.factions ?? [])])];
}

/**
 * Строка тирлиста, обрезанная до полей, которые использует payload.
 *
 * Имена полей совпадают с теми, что читает `metricsFor` в сборщике, поэтому там
 * ничего не меняется: обрезанная строка просто содержит меньше ключей.
 */
export interface TrimmedRow {
  id: string;
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  destroyedPointsByTarget: Record<string, number>;
  defenseVector: Record<string, number>;
  effectiveOffenseVector: Record<string, number>;
  universal: number;
  damagePer100: number;
  absorbedPer100: number;
  bulkPer100: number;
  censoredShare: number;
  unitType: string;
  tax: { damage: number; survivability: number };
  effectiveDamage: number;
  effectiveSurvivability: number;
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  vectorDamageScore: number;
  vectorSurvivabilityScore: number;
  vectorDamageFloor: number;
  vectorSurvivabilityFloor: number;
  utilityFlags: UtilityFlag[];
  utilityScore: number;
  totalScore: number;
  percentile: number;
  tier: TierRow['tier'];
}

/** Обрезка строки тирлиста до полей payload. */
export function trimRow(row: TierRow): TrimmedRow {
  return {
    id: row.id,
    rawMaxDamage: row.rawMaxDamage,
    bestTarget: row.bestTarget,
    bestTargetName: row.bestTargetName,
    destroyedPointsByTarget: row.destroyedPointsByTarget,
    defenseVector: row.defenseVector,
    effectiveOffenseVector: row.effectiveOffenseVector,
    universal: row.universal,
    damagePer100: row.damagePer100,
    absorbedPer100: row.absorbedPer100,
    bulkPer100: row.bulkPer100,
    censoredShare: row.censoredShare,
    unitType: row.unitType,
    tax: { damage: row.tax.damage, survivability: row.tax.survivability },
    effectiveDamage: row.effectiveDamage,
    effectiveSurvivability: row.effectiveSurvivability,
    normDamage: row.normDamage,
    normSurvivability: row.normSurvivability,
    normUtility: row.normUtility,
    vectorDamageScore: row.vectorDamageScore,
    vectorSurvivabilityScore: row.vectorSurvivabilityScore,
    vectorDamageFloor: row.vectorDamageFloor,
    vectorSurvivabilityFloor: row.vectorSurvivabilityFloor,
    utilityFlags: row.utilityFlags,
    utilityScore: row.utilityScore,
    totalScore: row.totalScore,
    percentile: row.percentile,
    tier: row.tier,
  };
}

/** Сжатая строка вкладки «юнит + лидер»: в JSON идёт именно такой набор. */
export interface AttachedPayload {
  unitId: string;
  leaderId: string | null;
  name: string;
  faction: string;
  factions: string[];
  models: number;
  points: number;
  tier: TierRow['tier'];
  totalScore: number;
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  effectiveSurvivability: number;
  utilityScore: number;
  utilityFlags: UtilityFlag[];
}

/**
 * Пустая сетка «парадигма × режим» с ключами сразу во всех комбинациях.
 *
 * Ключи создаются заранее и в фиксированном порядке. Без этого ключи
 * добавлялись бы в момент сообщения от воркера, и порядок зависел бы от того,
 * кто закончил раньше: значения совпадали бы, а байты в JSON — нет.
 */
export function emptyParadigmGrid<T>(
  paradigms: readonly string[],
  modes: readonly string[],
  empty: () => T
): Record<string, Record<string, T>> {
  const grid: Record<string, Record<string, T>> = {};
  for (const paradigm of paradigms) {
    const byMode: Record<string, T> = {};
    for (const mode of modes) {
      byMode[mode] = empty();
    }
    grid[paradigm] = byMode;
  }
  return grid;
}

/** Обрезка строк вкладки «юнит + лидер» до формы, уходящей в JSON. */
export function trimAttached(
  rows: TierRow[],
  prepared: PreparedUnit[],
  leaders: LeaderDefinition[]
): AttachedPayload[] {
  return rows.map((row) => ({
    unitId: row.id.split('+')[0],
    leaderId: row.id.split('+')[1] ?? null,
    name: row.name,
    faction: row.faction,
    factions: pairFactionsOf(row.id, prepared, leaders),
    models: row.models,
    points: row.points,
    tier: row.tier,
    totalScore: row.totalScore,
    rawMaxDamage: row.rawMaxDamage,
    bestTarget: row.bestTarget,
    bestTargetName: row.bestTargetName,
    effectiveSurvivability: row.effectiveSurvivability,
    utilityScore: row.utilityScore,
    utilityFlags: row.utilityFlags,
  }));
}
