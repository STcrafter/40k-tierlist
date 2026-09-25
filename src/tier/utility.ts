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
  | 'Scouts'
  | 'Infiltrator'
  | 'Fly'
  | 'High_Speed'
  | 'FNP_5+'
  | 'FNP_6+'
  | 'Stealth'
  | 'Lurkers'
  | 'Smoke'
  | 'OC_3+'
  | 'Aura_Re_roll_1s'
  | 'Aura_Ward'
  | 'Screening';

/** Сработавший флаг и его цена в баллах. */
export interface UtilityFlag {
  id: UtilityFlagId;
  points: number;
  /** Что именно в данных дало флаг (для проверки глазами). */
  reason: string;
}

/**
 * Баллы за флаги.
 *
 * Ориентир — не «сколько правил это даёт», а насколько флаг РЕДОК и насколько
 * сильно меняет игру. Замер по 1093 юнитам (доля флага в наборе → доля в S):
 *   Tie_up   60.7% → 84.5%  — срабатывал у 2/3 набора, то есть измерял не
 *     редкость, а наличие рукопашного оружия; как «полезность» бесполезен.
 *   OC_3+    27.6% → 82.7%  — самый высокий подъём при цене 2 очка: способность
 *     почти не влияет на бой, поэтому и оценена ниже.
 *   Deep_Strike 29.3% → 58.2% — реально решает партию, поднято до 3.
 *   Stealth/Lurkers 1.0% — очень редки и решают исход, подняты до 2.
 */
export const UTILITY_POINTS: Record<UtilityFlagId, number> = {
  Deep_Strike: 3,
  Reserves: 2,
  Scouts: 3,
  Infiltrator: 3,
  Fly: 1,
  High_Speed: 1,
  'FNP_5+': 2,
  'FNP_6+': 2,
  Stealth: 2,
  Lurkers: 2,
  Smoke: 2,
  'OC_3+': 1,
  Aura_Re_roll_1s: 2,
  Aura_Ward: 2,
  Screening: 3,
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
 * Убирает из текста отрицания, прежде чем искать способность.
 *
 * В BSData много апгрейдов вида «it loses the Scouts 9" ability» или
 * «remove the Infiltrators». Без этого отряды, которые способность ПОТЕРЯЛИ,
 * считались бы обладающими ею: на 1093 даташитах ложных срабатываний было 6.
 */
function withoutNegations(text: string): string {
  return text.replace(/[^.]*\b(loses?|lost|remove[sd]?|no longer has|without)\b[^.]*/gi, ' ');
}

/**
 * Разбор даташита в список utility-флагов.
 *
 * Все флаги выводятся из данных BSData, а не задаются руками, и у каждого
 * сохраняется `reason` — что именно в данных его дало, чтобы список можно
 * было проверить глазами.
 *
 * Раньше набор принимал `UtilityContext` с рукопашным уроном: по нему
 * выдавался Tie_up, но тот срабатывал у 60.7% юнитов и лишь дублировал ось
 * ближнего боя, поэтому и был убран вместе с контекстом.
 */

export function detectUtilityFlags(datasheet: BsDatasheet): UtilityFlag[] {
  const flags: UtilityFlag[] = [];
  const add = (id: UtilityFlagId, reason: string): void => {
    if (flags.some((flag) => flag.id === id)) return;
    flags.push({ id, points: UTILITY_POINTS[id], reason });
  };

  const abilities = datasheet.abilities;
  const rawTexts = datasheetsTexts(datasheet).map((text) => text.toLowerCase());
  // Для поиска самой способности отрицания вырезаются: «loses the Scouts 9"»
  // не должно превращать отряд в обладателя Scouts.
  const texts = rawTexts.map((text) => withoutNegations(text));
  const names = abilities.map((ability) => ability.name.toLowerCase());
  const keywords = datasheet.keywords.map((keyword) => keyword.trim().toLowerCase());
  const all = texts.join(' ');

  // --- Небоевые вводные: атака с фланга/сверху, резервы. ---
  if (names.includes('deep strike') || texts.some((t) => t.includes('deep strike'))) {
    add('Deep_Strike', 'способность Deep Strike');
  }
  if (
    names.includes('cult ambush') ||
    texts.some((t) => t.includes('reserves') || t.includes('tunnelling') || t.includes('tunneling'))
  ) {
    add('Reserves', 'ввод в бой из резерва (Cult Ambush/Reserves)');
  }

  // --- Скауты и инфильтраторы: ввод в бой вне фазы развёртывания. ---
  // В BSData это не кейворды, а именованные способности «Scouts 7"» и
  // «Infiltrators», поэтому ищем их по тексту. Слово «Scout» само по себе
  // пропускаем: «Scout Squad» встречается в списках присоединения лидеров.
  if (/\bscouts\s+\d/i.test(all)) add('Scouts', 'способность Scouts (ввод до первой фазы)');
  if (/\binfiltrators\b/i.test(all) || /\binfiltrator\s+squad\b/i.test(datasheet.name)) {
    add('Infiltrator', 'способность Infiltrators (ввод в любой момент)');
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

  // --- Дым. У 188 юнитов это кейворд даташита, но у части (например у
  // Achilles Ridgerunners) его выдаёт способность «has the SMOKE keyword».
  if (keywords.includes('smoke') || texts.some((t) => /\bsmoke keyword\b/.test(t))) {
    add('Smoke', 'кейворд SMOKE (дым накрывает цель)');
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

  // --- Связывание: мешают врагу вступить в ближний бой рядом. ---
  // Раньше Tie_up выдавался любому отряду с meleePer100 ≥ 1.0, то есть
  // срабатывал у 60.7% набора и просто дублировал ось ближнего боя. Теперь
  // флаг означает только настоящее «нельзя вступить в бой».
  if (texts.some((t) => t.includes('cannot be engaged') || t.includes('cannot engage'))) {
    add('Screening', 'не даёт врагу вступить в ближний бой рядом');
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

