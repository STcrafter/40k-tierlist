/**
 * ЕДИНЫЙ разбор Feel No Pain.
 *
 * Раньше правило читалось дважды, и обе копии были правы по-своему:
 *   - `combat/adapter.ts::fnpOf` шёл в боевую модель и умел отбрасывать
 *     служебную запись BSData («This ability always takes the form **Feel No Pain
 *     X+**») и условные гранты («While a friendly … unit is within 6"»);
 *   - `tier/utility.ts` шёл в отчёт и не умел НИЧЕГО из этого: порог брался
 *     из имени правила, отфильтрованы были только отрицания.
 * Замер по 1460 даташитам: расходились 54 — у 40 флаг был, а в модели FNP был
 * null, у 14 наоборот. Оба расхождения молчали: ни тир, ни тест об этом не
 * говорили.
 *
 * Теперь разбор один, и оба потребителя берут его отсюда. Разница между ними
 * осталась ровно одна и она осознанная: бой интересуется постоянным FNP модели,
 * а отчёт — тем, что игрок видит на даташите, поэтому для отчёта отсекаются
 * условные гранты (см. `permanentFnpOf`).
 */

/** Область действия FNP: 'all' — любой урон, 'mortals' — только мортиды. */
export type FnpScope = 'all' | 'mortals';

export interface FnpReading {
  /** Порог невеливания: 5 → FNP 5+ (ниже = строже). */
  threshold: number;
  scope: FnpScope;
}

/** Оба чтения сразу: постоянное (в бой) и «как на даташите» (в отчёт). */
export interface FnpReadings {
  permanent: FnpReading | null;
  reported: FnpReading | null;
}

/** Тексты всех правил и способностей даташита одной строкой. */
function textsOf(datasheet: {
  abilities: Array<{ name: string; description: string }>;
  rules: Array<{ name: string; description: string }>;
}): Array<{ name: string; description: string; text: string }> {
  return [...datasheet.abilities, ...datasheet.rules].map((ability) => ({
    ...ability,
    text: `${ability.name} ${ability.description}`,
  }));
}

/**
 * Служебная запись BSData: «Feel No Pain 5+» + «Feel No Pain» с текстом
 * «This ability always takes the form **Feel No Pain X+**».
 *
 * Это НЕ грант отряду, а расшифровка самой механики: такая пара есть почти у
 * каждого FNP в базе, и без фильтра «FNP есть» получается у 14 юнитов, у
 * которых на самом деле защиты нет (Beastboss — самый крупный случай).
 */
function isServiceNote(item: { description: string }): boolean {
  return /always takes the form/i.test(item.description);
}

/**
 * Временный или условный грант: «While a friendly … unit is within 6"»,
 * «until the end of the turn», «and an Objective Control characteristic of 15».
 *
 * Модель не должна получать постоянный FNP, которого у неё нет по умолчанию:
 * способность зависит от расположения отряда, а замер идёт по свежему бою без
 * карты. Для отчёта это тоже лишнее — игрок видит условный текст, а не 5+.
 */
function isConditionalGrant(text: string): boolean {
  return /\bunless\b|while |at the (start|end)|until the end|instead|this turn|each turn|for a turn|in your \w+ phase|objective control characteristic|spiritual backlash|\bbound\b|unbound|empowered|whilst |as long as |while this|each time an attack/i.test(
    text
  );
}

/** «against mortal wounds» — ограничение области; псионика мимо FNP в любом случае. */
function scopeOf(text: string): FnpScope | null {
  const mentionsMortal = /\bmortal\s+wounds?\b/i.test(text);
  const mentionsPsychic = /\bpsychic\s+attacks?\b/i.test(text);
  // «against psychic attacks» целиком не моделируется: это защита от другого
  // канала урона, а не невеличение ранений.
  if (mentionsPsychic && !mentionsMortal) return null;
  return mentionsMortal ? 'mortals' : 'all';
}

/**
 * Сильнее ли `candidate`, чем текущий лучший.
 *
 * FNP — НЕ «больше значит лучше»: невеличение на 3+ защищает больше ранений,
 * чем на 6+, поэтому сильнее МЕНЬШИЙ порог. При равном пороге сильнее 'all':
 * та же защита мортидов плюс обычный урон.
 *
 * Направление закреплено тестом в fnp.test.ts: в проекте это правило жило в
 * четырёх местах, и в трёх из них стоял `Math.max` — то есть аура FNP 5+ у
 * модели с FNP 3+ ухудшала защиту, а разбор BSData оставлял отряду более
 * слабый из двух встречающихся порогов.
 */
export function isStrongerFnp(candidate: FnpReading, best: FnpReading | null): boolean {
  if (best === null) return true;
  if (candidate.threshold !== best.threshold) return candidate.threshold < best.threshold;
  return candidate.scope === 'all' && best.scope === 'mortals';
}

/** Лучшее из двух FNP; null означает «защиты нет». */
export function strongerFnp(a: FnpReading | null, b: FnpReading | null): FnpReading | null {
  if (a === null) return b;
  if (b === null) return a;
  return isStrongerFnp(a, b) ? a : b;
}

/**
 * ПОСТОЯННЫЙ Feel No Pain моделей отряда — то, что попадает в бой.
 *
 * Условные и временные гранты отбрасываются: замер идёт по свежему отряду без
 * карты, и FNP «пока рядом с капелланом» в нём просто не выполняется.
 */
function permanentReading(datasheet: Parameters<typeof textsOf>[0]): FnpReading | null {
  let best: FnpReading | null = null;
  for (const item of textsOf(datasheet)) {
    if (isServiceNote(item)) continue;
    if (!/feel\s*no\s*pain/i.test(item.text)) continue;
    if (isConditionalGrant(item.text)) continue;
    const scope = scopeOf(item.text);
    if (scope === null) continue;
    for (const match of item.text.matchAll(/feel\s*no\s*pain\s*(\d)\s*\*?\+/gi)) {
      const candidate: FnpReading = { threshold: Number(match[1]), scope };
      best = strongerFnp(candidate, best);
    }
  }
  return best;
}

/**
 * FNP, КАК ЕГО ВИДИТ ИГРОК НА ДАТАШИТЕ — то, что попадает в отчёт полезности.
 *
 * Отличие от постоянного одно: условные гранты НЕ отбрасываются, потому что игрок
 * действительно видит «Feel No Pain 5+» в тексте и вправе рассчитывать на неё,
 * когда условие выполнено. Служебная запись «always takes the form» отбрасывается
 * и здесь — она не читается как способность.
 */
function reportedReading(datasheet: Parameters<typeof textsOf>[0]): FnpReading | null {
  let best: FnpReading | null = null;
  for (const item of textsOf(datasheet)) {
    if (isServiceNote(item)) continue;
    if (!/feel\s*no\s*pain/i.test(item.text)) continue;
    const scope = scopeOf(item.text);
    if (scope === null) continue;
    for (const match of item.text.matchAll(/feel\s*no\s*pain\s*(\d)\s*\*?\+/gi)) {
      const candidate: FnpReading = { threshold: Number(match[1]), scope };
      best = strongerFnp(candidate, best);
    }
  }
  return best;
}

/**
 * Оба чтения FNP даташита — из одного разбора.
 *
 * Различие между ними не в коде, а в смысле: бой интересуется постоянной
 * защитой, отчёт — тем, что игрок видит на даташите. Оно возвращается вместе с
 * результатом, а не прячется в двух копиях разбора: иначе расхождение снова
 * станет невидимым (именно так оно и прожило 54 даташита молча).
 */
export function fnpOf(datasheet: Parameters<typeof textsOf>[0]): FnpReadings {
  return { permanent: permanentReading(datasheet), reported: reportedReading(datasheet) };
}