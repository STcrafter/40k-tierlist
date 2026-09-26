/**
 * Небоевая полезность юнита: разбор способностей BSData в utility-флаги.
 *
 * КАЖДЫЙ флаг принадлежит одной из трёх категорий, и это не украшение:
 *
 *  - `modeled` — уже смоделировано в боевом расчёте, поэтому в utility идти
 *    НЕ должно. FNP реально бросается в `simulate.ts` (feelNoPain), Stealth
 *    повышает порог попадания в `rules.ts`. Платить за них ещё раз в общей
 *    оси значило бы удваивать одно и то же свойство.
 *  - `archetype` — маркер типа юнита, а не игровая ценность. У OC 3+ был
 *    подъём в S с 27.6% до 82.7%: это описание «это техника/монстр», а не
 *    причина силы. Такие флаги видны в отчёте, но в скоре не участвуют.
 *  - `strategic` — собственно внебоевая ценность: ввод в бой вне фазы
 *    развёртывания, экранирование, дым. Именно она идёт в Total.
 *
 * Баллы суммируются и нормируются ПО РАНГУ (см. scoring.ts): при 299 юнитах
 * с нулём min-max делал шкалу слишком крутой — 3 балла из 12 превращались в
 * четверть итогового скора.
 */

import type { BsDatasheet, BsModelVariant } from '../bsdata/types.ts';
import { manualAbilityOf, type ManualUtilityFlagId } from '../manual/abilities.ts';

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
  | 'Screening'
  // Ручной слой (src/manual/abilities.ts) — см. ManualUtilityFlagId.
  | ManualUtilityFlagId;

/**
 * Категория флага: смоделирован в бою / маркер архетипа / стратегическая ценность.
 *
 * Только `strategic` входит в Total. Остальные видны в интерфейсе, чтобы
 * не потерять сведения, но не двигают тир.
 */
export type UtilityCategory = 'modeled' | 'archetype' | 'strategic';

/**
 * Разделение по категориям.
 *
 * `modeled`: FNP и Stealth/Lurkers учитываются прямо в симуляции, второй раз
 * платить за них нельзя. `archetype`: OC 3+, Move 10" и FLY — свойства типа.
 */
export const UTILITY_CATEGORY: Record<UtilityFlagId, UtilityCategory> = {
  'FNP_5+': 'modeled',
  'FNP_6+': 'modeled',
  Stealth: 'modeled',
  Lurkers: 'modeled',
  'OC_3+': 'archetype',
  High_Speed: 'archetype',
  Fly: 'archetype',
  Deep_Strike: 'strategic',
  Infiltrator: 'strategic',
  Scouts: 'strategic',
  Screening: 'strategic',
  Reserves: 'strategic',
  Smoke: 'strategic',
  Aura_Re_roll_1s: 'strategic',
  Aura_Ward: 'strategic',
  // Ручные способности Sororitas — внебоевая ценность, но часть эффектов
  // (Devastating Wounds, регенерация) уже смоделирована в бою. Флаг отражает
  // СТРАТЕГИЧЕСКУЮ часть: способность менять игру, а не дублирует урон.
  Sororitas_Devastating_Aura: 'strategic',
  Sororitas_Anti_Warp: 'strategic',
  Saint_Celestine_Blessing: 'strategic',
  Triumph_Relic_Blessing: 'strategic',
  Sororitas_Stealth_Aura: 'strategic',
  Sororitas_Extra_Attacks: 'strategic',
  Sororitas_Canoness_Aura: 'strategic',
  Sororitas_Canoness_Jump_Aura: 'strategic',
  Sororitas_Dialogus: 'strategic',
  Sororitas_Dogmata: 'strategic',
  Sororitas_Imagifier: 'strategic',
  Sororitas_Battle_Sisters: 'strategic',
  Sororitas_Immolator: 'strategic',
  Sororitas_Celestian_Insidiants: 'strategic',
  Sororitas_Dominion: 'strategic',
  Sororitas_Retributors: 'strategic',
  Sororitas_Sanctifiers: 'strategic',
  Sororitas_Seraphim: 'strategic',
  Sororitas_Novitiates: 'strategic',
  Sororitas_Castigator: 'strategic',
  Sororitas_Exorcist: 'strategic',
  Sororitas_Penitent_Engines: 'strategic',
};

/** Флаги, которые реально входят в итоговый скор. */
export const isScoredFlag = (id: UtilityFlagId): boolean => UTILITY_CATEGORY[id] === 'strategic';

/** Сработавший флаг, его категория и цена в баллах. */
export interface UtilityFlag {
  id: UtilityFlagId;
  points: number;
  /** Что именно в данных дало флаг (для проверки глазами). */
  reason: string;
  /** Входит ли флаг в итоговый скор тирлиста. */
  category: UtilityCategory;
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
  Sororitas_Devastating_Aura: 2,
  Sororitas_Anti_Warp: 2,
  Saint_Celestine_Blessing: 3,
  Triumph_Relic_Blessing: 4,
  Sororitas_Stealth_Aura: 2,
  Sororitas_Extra_Attacks: 2,
  Sororitas_Canoness_Aura: 2,
  Sororitas_Canoness_Jump_Aura: 2,
  Sororitas_Dialogus: 2,
  Sororitas_Dogmata: 2,
  Sororitas_Imagifier: 1,
  Sororitas_Battle_Sisters: 3,
  Sororitas_Immolator: 2,
  Sororitas_Celestian_Insidiants: 1,
  Sororitas_Dominion: 2,
  Sororitas_Retributors: 1,
  Sororitas_Sanctifiers: 2,
  Sororitas_Seraphim: 1,
  Sororitas_Novitiates: 2,
  Sororitas_Castigator: 1,
  Sororitas_Exorcist: 1,
  Sororitas_Penitent_Engines: 2,
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
    flags.push({ id, points: UTILITY_POINTS[id], reason, category: UTILITY_CATEGORY[id] });
  };

  const abilities = datasheet.abilities;
  const rawTexts = datasheetsTexts(datasheet).map((text) => text.toLowerCase());
  // Для поиска самой способности отрицания вырезаются: «loses the Scouts 9"»
  // не должно превращать отряд в обладателя Scouts.
  const texts = rawTexts.map((text) => withoutNegations(text));
  // Имена берём из abilities И rules: многие даташиты (например, с «Deep
  // Strike») держат правило именно в `rules`, и поиск только по abilities
  // давал 0 срабатываний. Текст правила — уже с name+description.
  const names = [...abilities, ...datasheet.rules].map((ability) => ability.name.toLowerCase());
  const keywords = datasheet.keywords.map((keyword) => keyword.trim().toLowerCase());
  const all = texts.join(' ');

  /**
   * Имена правил в BSData — СТРУКТУРИРОВАННЫЕ данные: «Deep Strike», «Scouts»,
   * «Infiltrators», «Stealth», «Feel No Pain 5+» встречаются как `name` у
   * десятков и сотен юнитов. Поэтому сначала проверяем имя, и лишь если его нет
   * — падаем обратно на текст описания. Замер по базе: у 156 юнитов FNP есть
   * как имя правила и лишь у 73 — только в тексте, то есть текстовый разбор
   * видел меньше половины.
   */
  const hasRuleNamed = (exact: string | RegExp): boolean => names.some((name) =>
    typeof exact === 'string' ? name === exact : exact.test(name)
  );

  // --- Небоевые вводные: атака с фланга/сверху, резервы. ---
  if (hasRuleNamed('deep strike') || hasRuleNamed(/^deep strike\s/)) {
    add('Deep_Strike', 'способность Deep Strike');
  }
  if (
    names.includes('cult ambush') ||
    texts.some((t) => t.includes('reserves') || t.includes('tunnelling') || t.includes('tunneling'))
  ) {
    add('Reserves', 'ввод в бой из резерва (Cult Ambush/Reserves)');
  }

  // --- Скауты и инфильтраторы: ввод в бой вне фазы развёртывания. ---
  // В BSData это именованные правила «Scouts N"» и «Infiltrators» (104 и 76).
  if (hasRuleNamed(/^scouts\b/) || /\bscouts\s+\d/i.test(all)) {
    add('Scouts', 'способность Scouts (ввод до первой фазы)');
  }
  if (hasRuleNamed(/^infiltrators\b/) || /\binfiltrators\b/i.test(all) || /\binfiltrator\s+squad\b/i.test(datasheet.name)) {
    add('Infiltrator', 'способность Infiltrators (ввод в любой момент)');
  }

  // --- Скорость: полёт или быстрый бег. ---
  if (keywords.includes('fly')) add('Fly', 'кейворд FLY');
  const maxMove = Math.max(...profilesOf(datasheet).map((p) => p.move ?? 0));
  if (maxMove >= 10) add('High_Speed', `Move ${maxMove}"`);

  // --- Feel No Pain. В BSData это правило с именем «Feel No Pain 5+», то есть
  // порог лежит в ИМЕНИ правила, а не в его описании. Поэтому сначала смотрим
  // имена («Feel No Pain 6+» → 6), и только затем падаем на текст.
  const fnpFromName = names
    .map((name) => /feel\s*no\s*pain\s*(\d)/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const fnp6 = fnpFromName.some((n) => n >= 6) || hasFnpAtLeast(texts, 6);
  const fnp5 = fnp6 || fnpFromName.some((n) => n === 5) || hasFnpAtLeast(texts, 5);
  if (fnp6) add('FNP_6+', 'Feel No Pain 6+');
  else if (fnp5) add('FNP_5+', 'Feel No Pain 5+');

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

  // --- Ручной слой (src/manual/abilities.ts). ---
  // Эффекты, которые не выводятся из профилей и кейвордов: Devastating Wounds
  // от способности, регенерация и воскрешение, бонус к мортидам. Флаги
  // добавляются в конце, чтобы обычный разбор не мог их затмить.
  for (const flag of manualAbilityOf(datasheet.id)?.utilityFlags ?? []) {
    add(flag.id, flag.reason);
  }

  return flags;
}

/** Все тексты способностей и правил даташита одной строкой. */
function datasheetsTexts(datasheet: BsDatasheet): string[] {
  return [...datasheet.abilities, ...datasheet.rules].map(
    (ability) => `${ability.name} ${ability.description}`
  );
}

/**
 * Баллы, влияющие на Total: только СТРАТЕГИЧЕСКИЕ флаги.
 *
 * Флаги `modeled` (FNP, Stealth, Lurkers) уже учтены в боевой симуляции, а
 * `archetype` (OC 3+, Move 10", FLY) описывают тип юнита, а не его ценность.
 * Платить за них в общей оси значило бы либо удвоить смоделированное свойство,
 * либо удвоить ось урона/живучести. Поэтому в скоре остаются только ввод в
 * бой вне фазы развёртывания, экранирование, дым и ауры.
 *
 * @param flags полный список флагов юнита
 * @param onlyScored true — только стратегические (для Total)
 */
export function utilityScoreOf(flags: UtilityFlag[], onlyScored = true): number {
  const sum = flags
    .filter((flag) => !onlyScored || isScoredFlag(flag.id))
    .reduce((total, flag) => total + flag.points, 0);
  return Math.min(UTILITY_MAX, sum);
}

/** Сколько всего баллов набрано по всем флагам, включая не влияющие на скор. */
export function fullUtilityScoreOf(flags: UtilityFlag[]): number {
  return utilityScoreOf(flags, false);
}

