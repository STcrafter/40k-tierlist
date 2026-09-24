/**
 * Небоевая полезность юнита: разбор способностей BSData в utility-флаги.
 *
 * Каждый флаг даёт очки по правилам тирлиста (см. UTILITY_POINTS), сумма
 * ограничивается сверху 20 баллами. Флаги выводятся из данных, а не задаются
 * руками: `Feel No Pain 5+`, `(Aura)` с re-roll/ward, `Screening`, OC из
 * числовой характеристики профиля и т.д. Так список остаётся проверяемым:
 * для каждого флага сохраняется `reason` — что именно в данных его дало.
 *
 * Спорные случаи помечены в коде явно: там, где в базе нет однозначного
 * признака (связывание), используется документированный запасной вариант.
 */

import type { BsDatasheet, BsModelVariant } from '../bsdata/types.ts';

/** Идентификатор флага полезности. */
export type UtilityFlagId =
  | 'Deep_Strike'
  | 'Reserves'
  | 'Fly'
  | 'High_Speed'
  | 'FNP_5+'
  | 'FNP_6+'
  | 'Stealth'
  | 'Lurkers'
  | 'OC_3+'
  | 'Aura_Re_roll_1s'
  | 'Aura_Ward'
  | 'Screening'
  | 'Tie_up';

/** Сработавший флаг и его цена в баллах. */
export interface UtilityFlag {
  id: UtilityFlagId;
  points: number;
  /** Что именно в данных дало флаг (для проверки глазами). */
  reason: string;
}

/** Баллы за флаги — ровно по ТЗ тирлиста. */
export const UTILITY_POINTS: Record<UtilityFlagId, number> = {
  Deep_Strike: 2,
  Reserves: 2,
  Fly: 1,
  High_Speed: 1,
  'FNP_5+': 2,
  'FNP_6+': 2,
  Stealth: 1,
  Lurkers: 1,
  'OC_3+': 2,
  Aura_Re_roll_1s: 2,
  Aura_Ward: 2,
  Screening: 3,
  Tie_up: 3,
};

/** Потолок utility_score. */
export const UTILITY_MAX = 20;

/** '12"' → 12; '20+"' → 20. */
function parseMovement(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** '3' → 3; null, если характеристики нет. */
function parseNumber(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*(-?\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Наибольший OC и движение среди вариантов даташита. */
function profilesOf(datasheet: BsDatasheet): Array<{ oc: number | null; move: number | null }> {
  const variants: BsModelVariant[] = datasheet.variants.length > 0 ? datasheet.variants : [];
  return variants.map((variant) => ({
    oc: parseNumber(variant.profile?.objectiveControl ?? null),
    move: parseMovement(variant.profile?.movement ?? null),
  }));
}

/** Сколько FNP встречается в текстах способностей и правил. */
function hasFnpAtLeast(texts: string[], value: 5 | 6): boolean {
  const pattern = new RegExp(`feel\\s*no\\s*pain\\s*${value}\\s*\\+`, 'i');
  return texts.some((text) => pattern.test(text));
}

/**
 * Разбор даташита в список utility-флагов.
 *
 * `meleeOutput` — рукопашный урон на 100 очков. Нужен только для флага
 * связывания: в базе нет однозначного признака «этот отряд удерживает врага»,
 * поэтому используется запасной вариант — рукопашный отряд с реальной
 * угрозой в ближнем бою. Порог настраивается (`tieUpThreshold`).
 */
export interface UtilityContext {
  /** Рукопашный урон на 100 очков — для флага связывания. */
  meleePer100?: number | null;
  /** Порог «руки работают» для флага Tie_up (по умолчанию 1.0). */
  tieUpThreshold?: number;
}

export function detectUtilityFlags(
  datasheet: BsDatasheet,
  context: UtilityContext = {}
): UtilityFlag[] {
  const flags: UtilityFlag[] = [];
  const add = (id: UtilityFlagId, reason: string): void => {
    if (flags.some((flag) => flag.id === id)) return;
    flags.push({ id, points: UTILITY_POINTS[id], reason });
  };

  const abilities = datasheet.abilities;
  const texts = [...datasheetsTexts(datasheet)].map((text) => text.toLowerCase());
  const names = abilities.map((ability) => ability.name.toLowerCase());
  const keywords = datasheet.keywords.map((keyword) => keyword.toLowerCase());

  // --- Небоевые вводные: атака с фланга/сверху, резервы. ---
  if (names.includes('deep strike') || texts.some((t) => t.includes('deep strike'))) {
    add('Deep_Strike', 'способность Deep Strike');
  }
  if (
    names.includes('scouts') ||
    names.includes('cult ambush') ||
    texts.some((t) => t.includes('reserves') || t.includes('tunnelling') || t.includes('tunneling'))
  ) {
    add('Reserves', 'ввод в бой из резерва (Scouts/Cult Ambush/Reserves)');
  }

  // --- Скорость: полёт или быстрый бег. ---
  if (keywords.includes('fly')) add('Fly', 'кейворд FLY');
  const maxMove = Math.max(...profilesOf(datasheet).map((p) => p.move ?? 0));
  if (maxMove >= 10) add('High_Speed', `Move ${maxMove}"`);

  // --- Feel No Pain: в базе это правило «Feel No Pain X+» на юните. ---
  if (hasFnpAtLeast(texts, 6)) add('FNP_6+', 'Feel No Pain 6+');
  else if (hasFnpAtLeast(texts, 5)) add('FNP_5+', 'Feel No Pain 5+');

  // --- Скрытность. ---
  if (names.includes('stealth') || names.includes('penumbral puppetry')) {
    add('Stealth', 'способность Stealth / Penumbral Puppetry');
  }
  if (names.some((name) => name.includes('lurker') || name.includes('shadowsight'))) {
    add('Lurkers', 'умение засадчика (lurker/shadowsight)');
  }

  // --- Objective Control 3+ (берём максимум по моделям отряда). ---
  const maxOc = Math.max(...profilesOf(datasheet).map((p) => p.oc ?? 0));
  if (maxOc >= 3) add('OC_3+', `OC ${maxOc}`);

  // --- Ауры, помогающие перебросам или защите. ---
  for (const ability of abilities) {
    const name = ability.name.toLowerCase();
    if (!name.includes('aura')) continue;
    const text = ability.description.toLowerCase();
    const rerolls = text.includes('re-roll') || text.includes('reroll');
    const ward = text.includes('ward') || text.includes('feel no pain');
    if (rerolls && (text.includes('1') || text.includes('d6'))) {
      add('Aura_Re_roll_1s', `аура «${ability.name}» с перебросом`);
    } else if (ward) {
      add('Aura_Ward', `аура «${ability.name}» с защитой`);
    }
  }

  // --- Связывание: мешают врагу вступить в ближний бой. ---
  if (texts.some((t) => t.includes('cannot be engaged') || t.includes('cannot engage'))) {
    add('Screening', 'не даёт врагу вступить в ближний бой рядом');
  } else {
    const threshold = context.tieUpThreshold ?? 1.0;
    const melee = context.meleePer100 ?? 0;
    if (melee >= threshold) {
      add('Tie_up', `рукопашная угроза ${melee.toFixed(2)} на 100 очков`);
    }
  }

  return flags;
}

/** Все тексты способностей и правил даташита одной строкой. */
function datasheetsTexts(datasheet: BsDatasheet): string[] {
  return [...datasheet.abilities, ...datasheet.rules].map(
    (ability) => `${ability.name} ${ability.description}`
  );
}

/** Сумма баллов по флагам с потолком UTILITY_MAX. */
export function utilityScoreOf(flags: UtilityFlag[]): number {
  const sum = flags.reduce((total, flag) => total + flag.points, 0);
  return Math.min(UTILITY_MAX, sum);
}

