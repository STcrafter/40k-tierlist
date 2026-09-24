/**
 * Разбор Datasheets_options → декларативные правила набора снаряжения.
 *
 * Модуль покрывает 14 семейств формулировок Wahapedia (см. matchScope) и
 * превращает каждую строку в LoadoutOption, пригодный и для применения выбора
 * игрока (loadout/apply.ts), и для полного перебора конфигураций
 * (loadout/enumerate.ts).
 *
 * Особые случаи данных:
 *  - 269 строк 'None' — пропускаются (считаются в skippedNone);
 *  - строки с button='*' — ограничения ('You cannot select the same weapon …'),
 *    привязываются к предыдущей опции;
 *  - 'If this unit contains 10 models:<ul>…' — каждая <li> это ОТДЕЛЬНАЯ опция
 *    с условием по размеру отряда;
 *  - 'up to two of the following, and can take duplicates' (Tau-дроны) —
 *    варианты НЕ взаимоисключающие и допускают дубликаты;
 *  - названия оружия из текста сверяются с каталогом; ненайденные попадают
 *    в unmatched и в отчёт, но опция всё равно создаётся.
 */

import type { OptionRow } from '../raw/types.ts';
import { cleanText, collapseWhitespace, parseCountWord, splitListItems } from '../normalize/text.ts';
import { parseIntOrNull } from '../normalize/numbers.ts';
import { coreSlug } from '../normalize/match.ts';
import { findWeaponGroup } from './weapons.ts';
import type { WeaponGroup } from '../types/unit.ts';
import type {
  LoadoutChoice,
  LoadoutOption,
  OptionFamily,
  OptionScope,
  WeaponRef,
} from '../types/loadout.ts';

export interface ParsedOptionsResult {
  options: LoadoutOption[];
  /** Все ограничения из строк с button='*'. */
  restrictions: string[];
  unparsed: Array<{ line: number; raw: string; reason: string }>;
  skippedNone: number;
}

/** Содержимое <li>…</li> (в данных такие списки задают варианты выбора). */
export function extractListItems(raw: string): string[] {
  const items: string[] = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const text = cleanText(match[1]);
    if (text !== '') items.push(text);
  }
  return items;
}

export interface WeaponRefsResult {
  refs: WeaponRef[];
  /** Имена оружия, не найденные в каталоге юнита. */
  unmatched: string[];
}

/**
 * '1 Big Skorcha and 1 Kustom Choppa' → [{name:'Big Skorcha',count:1}, …].
 *
 * `knownNames` — имена снаряжения без боевого профиля (из блока WARGEAR OPTIONS
 * в стоимости): они не попадают в unmatched, потому что их отсутствие в каталоге
 * профилей — норма данных, а не ошибка разбора.
 */
export function parseWeaponRefs(
  text: string,
  catalog: WeaponGroup[],
  knownNames: Set<string> | null = null
): WeaponRefsResult {
  const cleaned = cleanText(text)
    .replace(/\.$/, '')
    .replace(/\(\s*(?:you cannot|maximum)[^)]*\)/gi, ' ')
    // 'regimental standard (that model's hot-shot lasgun cannot be replaced)'
    .replace(/\s*\([^)]*\bcannot be replaced\b[^)]*\)/gi, ' ')
    // Пометки в квадратных скобках: 'medi-pack [that model's hot-shot lasgun
    // cannot be replaced]' — примечание, а не часть имени.
    .replace(/\[[^\]]*\]/g, ' ')
    .trim();

  const refs: WeaponRef[] = [];
  const unmatched: string[] = [];

  for (const part of splitListItems(cleaned)) {
    const withoutNote = part.replace(/\*+$/g, '').trim();
    if (withoutNote === '') continue;

    // 'one of the following' — ссылка на <ul>-список, а не имя оружия.
    if (/^(?:one\s+of\s+)?the following$/i.test(withoutNote)) continue;

    const counted = withoutNote.match(/^(\d+)\s+(.*)$/);
    const count = counted ? Number.parseInt(counted[1], 10) : 1;
    const name = (counted ? counted[2] : withoutNote)
      .replace(/^(?:a|an|the|each)\s+/i, '')
      .replace(/\*+$/g, '')
      .replace(/[\*:;,]+$/, '')
      .replace(/\[[^\]]*\]/g, ' ')
      .trim();
    if (name === '') continue;

    const group = findWeaponGroup(catalog, name);
    if (!group && !(knownNames && knownNames.has(coreSlug(name)))) unmatched.push(name);
    refs.push({ name, groupId: group ? group.id : null, count });
  }

  return { refs, unmatched };
}

export interface ActionMatch {
  action: 'replace' | 'add';
  /** Что заменяется (только для action='replace'). */
  baseText: string | null;
  /** Что игрок получает. */
  resultText: string;
}

/**
 * Определяет действие по остатку текста после отрезания области действия.
 * resultText может быть пустым — тогда варианты берутся из <ul><li>.
 */
export function parseAction(text: string): ActionMatch | null {
  const trimmed = text
    .replace(/^[,;\s]+/, '')
    .replace(/^can(?: each)?\s+/i, '')
    .replace(/\s*\*\*$/, '')
    // 'have each shuriken cannon it is equipped with replaced with …' —
    // 'that it is equipped with' не несёт смысла для имени базового оружия.
    .replace(/\s+(?:it is|they are)\s+equipped with\b/gi, '')
    .trim();
  if (trimmed === '') return null;

  // Базовое оружие отрезано вместе с областью действия: rest начинается
  // сразу с 'be replaced with…', настоящее baseText лежит в scopeMatch.
  const barePassive = trimmed.match(/^be\s+replaced\s+(?:with\s*)?:?\s*(.*)$/i);
  if (barePassive) {
    return { action: 'replace', baseText: null, resultText: barePassive[1] };
  }

  // 'have their bolt pistol replaced with 1 plasma pistol',
  // 'have their X replaced one of the following' (без 'with'),
  // 'its Inquisitorial melee weapon can be replaced with 1 force weapon'.
  const theirs = trimmed.match(
    /(?:^|\s)(?:(?:have|has)\s+(?:each\s+)?(?:their\s+|its\s+)?|its\s+)(.+?)\s+(?:(?:can\s+)?(?:be\s+)?)?replaced\s+(?:with\s*)?:?\s*(.*)$/i
  );
  if (theirs) {
    return { action: 'replace', baseText: theirs[1], resultText: theirs[2] };
  }

  // Пассив с (опциональным) 'can be': 'X can be replaced with 1 Y',
  // 'X can each be replaced with one of the following:', 'X replaced with 1 Y',
  // 'X replaced one of the following' (опечатка в данных без 'with').
  const passive = trimmed.match(
    /^(.+?)\s+(?:(?:can|may)\s+(?:each\s+)?(?:be\s+)?)?replace[ds]?\s+(?:with\s*)?:?\s*(.*)$/i
  );
  if (passive) {
    return { action: 'replace', baseText: passive[1], resultText: passive[2] };
  }

  // Активная форма: 'replace its neutron blaster with 1 T’au flamer',
  // 'replace one of their macro-scalpels with one of the following:'.
  const active = trimmed.match(
    /^replace\s+(?:(?:one\s+of\s+their|their|its|his|her|the|a|an)\s+)?(.+?)\s+(?:with|for)\s*:?\s*(.*)$/i
  );
  if (active) {
    return { action: 'replace', baseText: active[1], resultText: active[2] };
  }

  const activeSwapped = trimmed.match(
    /^(?:swaps?|exchanges?)\s+(?:its|their|his|her|the|a|an)\s+(.+?)\s+(?:with|for)\s*:?\s*(.*)$/i
  );
  if (activeSwapped) {
    return { action: 'replace', baseText: activeSwapped[1], resultText: activeSwapped[2] };
  }

  // Добавление снаряжения.
  const addition = trimmed.match(/^(?:be equipped|take|be given)\b(?:\s+with)?\s*:?\s*(.+)$/i);
  if (addition) {
    return { action: 'add', baseText: null, resultText: addition[1] };
  }

  // 'it can have 1 Aspect Shrine token.' (после 'For every 5 models…')
  // 'it can be equipped with one of the following:' (после 'For each Helbrute fist…')
  const itForm = trimmed.match(
    /^(?:it|they)\s+can\s+(?:have|be equipped(?:\s+with)?|take)\b\s*:?\s*(.+)$/i
  );
  if (itForm) {
    return { action: 'add', baseText: null, resultText: itForm[1] };
  }

  // 'this unit can be equipped with 2 Drakolithe.' (после 'For every 3 models…')
  const unitForm = trimmed.match(
    /^(?:this|the)\s+unit\s+can\s+(?:have|take|be\s+equipped(?:\s+with)?)\b\s*:?\s*(.+)$/i
  );
  if (unitForm) {
    return { action: 'add', baseText: null, resultText: unitForm[1] };
  }

  // Выбор из списка без результата в строке: 'select one of the following options:',
  // 'do one of the following:' — варианты лежат в <ul><li>.
  const listOnly = trimmed.match(
    /^(?:select|choose|do|may (?:select|choose|take|do))\s+one of the following(?:\s+\w+)*\s*:?\s*$/i
  );
  if (listOnly) {
    return { action: 'add', baseText: null, resultText: '' };
  }

  // '<X> is equipped with: <items>' — фиксированная комплектация именованной
  // модели (эти строки Wahapedia кладёт в options у мульти-модельных лидеров).
  const fixed = trimmed.match(/^(.+?)\s+is\s+equipped with\s*:?\s*(.+)$/i);
  if (fixed) {
    return { action: 'add', baseText: null, resultText: fixed[2] };
  }

  return null;
}

/** 'Boy models' → 'Boy'; 'models' → null. */
export function stripModelWord(text: string): string | null {
  const cleaned = cleanText(text)
    .replace(/\s*models?$/i, '')
    .replace(/^(?:additional|other)\s+/i, '')
    .trim();
  return cleaned === '' ? null : cleaned;
}

export interface ScopeMatch {
  family: OptionFamily;
  scope: OptionScope;
  /** Сколько моделей могут взять опцию (null = не ограничено / вычисляется позже). */
  capacity: number | null;
  /** 'For every N models' — вместимость = floor(size / N). */
  perModels: number | null;
  /** 'If this unit contains N models'. */
  minUnitModels: number | null;
  modelName: string | null;
  /** Остаток текста, начинающийся с действия ('have their X replaced with Y'). */
  rest: string;
  /** 'If this model is equipped with X' / 'If the Acothyst is not equipped with X'. */
  condition: string | null;
  /** Заменяемое оружие, если оно было отрезано вместе с областью действия:
   * 'The Alpha’s galvanic rifle can be replaced with …' → 'galvanic rifle'.
   */
  baseText?: string;
}

const COUNT_WORD = `(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

export function matchScope(input: string): ScopeMatch | null {
  const text = collapseWhitespace(cleanText(input));
  let working = text;

  // Условие доступности: 'If this model is equipped with X, …',
  // 'If the Acothyst is not equipped with X, …'. Отрезаем и сохраняем.
  let condition: string | null = null;
  const conditionMatch = working.match(
    /^if\s+((?:this|that)\s+model|[a-z][\w' -]*?)\s+is\s+(not\s+)?equipped with\s+(.+?),\s*/i
  );
  if (conditionMatch) {
    condition = collapseWhitespace(
      `if ${conditionMatch[1]} is ${conditionMatch[2] ?? ''}equipped with ${conditionMatch[3]}`
    );
    working = working.slice(conditionMatch[0].length).trim();
  }

  let minUnitModels: number | null = null;
  const sizeConditional = working.match(
    /^if this unit contains\s+(?:(?:only|at least)\s+)?(\d+)(?:\s+or\s+(?:fewer|less|more))?\s+models?\b[^a-z0-9]*/i
  );
  if (sizeConditional) {
    minUnitModels = Number.parseInt(sizeConditional[1], 10);
    working = working.slice(sizeConditional[0].length).trim();
  }

  const base = { perModels: null as number | null, minUnitModels, condition };

  // 'For every 5 models in this unit, 1 model can have their X replaced with Y'
  // 'For every four models…' (слово-числительное), 'For every 5 models in this unit:' (двоеточие).
  const perN = working.match(
    new RegExp(`^for every\\s+(${COUNT_WORD})\\s+[^,]*?[:,]\\s*`, 'i')
  );
  if (perN) {
    const perModels = parseCountWord(perN[1]);
    if (perModels === null) return null;
    let rest = working.slice(perN[0].length).trim();
    let modelName: string | null = null;
    let baseText: string | undefined;

    const quantifier = rest.match(
      new RegExp(`^(?:up to\\s+)?${COUNT_WORD}\\s+(.+?)\\s*can\\b\\s*`, 'i')
    );
    if (quantifier) {
      // '1 model can …' | '1 Serberys Sulphurhound’s 2 phosphor pistols can …'
      const holder = quantifier[2];
      const possessive = holder.match(/^(.+?)(?:'s|s')\s+(.+)$/i);
      if (possessive) {
        modelName = stripModelWord(possessive[1]);
        baseText = possessive[2];
      } else {
        modelName = stripModelWord(holder);
      }
      rest = rest.slice(quantifier[0].length).trim();
    }

    return {
      family: 'per-n',
      scope: { kind: 'models', count: null },
      capacity: null,
      modelName,
      rest,
      ...base,
      perModels,
      baseText,
    };
  }

  // 'Any number of models can each have their X replaced with Y'
  const anyNumber = working.match(
    /^any number of\s+(?:models?|([a-z][\w' -]*?)\s+models?)\s+can\s+(?:each\s+)?/i
  );
  if (anyNumber) {
    return {
      family: 'any-number',
      scope: { kind: 'models', count: null },
      capacity: null,
      modelName: anyNumber[1] ? stripModelWord(anyNumber[1]) : null,
      rest: working.slice(anyNumber[0].length).trim(),
      ...base,
    };
  }

  // 'All models in this unit can each …' / 'All models can each …'
  // / 'All Deathwing Knights in this unit can each …'
  const allModels = working.match(
    /^all\s+(?:models(?:\s+in this unit)?|([a-z][\w' -]*?)\s+in this unit)\s+can\s+(?:each\s+)?/i
  );
  if (allModels) {
    return {
      family: 'all-models',
      scope: { kind: 'models', count: null },
      capacity: null,
      modelName: allModels[1] ? stripModelWord(allModels[1]) : null,
      rest: working.slice(allModels[0].length).trim(),
      ...base,
    };
  }

  // 'For each Helbrute fist this model is equipped with, it can be equipped with …'
  // Вместимость = числу «штук» указанного снаряжения; аппроксимируем perModels=1.
  const forEach = working.match(/^for each\s+(.+?),\s*/i);
  if (forEach) {
    return {
      family: 'per-n',
      scope: { kind: 'models', count: null },
      capacity: null,
      modelName: null,
      rest: working.slice(forEach[0].length).trim(),
      ...base,
      perModels: 1,
      condition: forEach[1],
    };
  }

  // 'Up to 2 Kommando models can each be equipped with 1 Kustom Shoota.'
  const upTo = working.match(
    new RegExp(`^up to\\s+${COUNT_WORD}\\s+(?:(.+?)\\s+)?models?\\s+can\\s+(?:each\\s+)?`, 'i')
  );
  if (upTo) {
    const capacity = parseCountWord(upTo[1]) ?? 1;
    return {
      family: 'up-to-n',
      scope: { kind: 'models', count: capacity },
      capacity,
      modelName: upTo[2] ? stripModelWord(upTo[2]) : null,
      rest: working.slice(upTo[0].length).trim(),
      ...base,
    };
  }

  return matchScopeRemainder(working, base);
}

interface ScopeBase {
  perModels: number | null;
  minUnitModels: number | null;
  condition: string | null;
}

/** Оставшиеся семейства: одиночная модель, оружие модели, отряд, именованные модели. */
export function matchScopeRemainder(working: string, base: ScopeBase): ScopeMatch | null {
  // "Each of this model's shuriken catapults can be replaced with 1 flamer."
  const eachOf = working.match(/^each of (?:this|the) model'?s\s+/i);
  if (eachOf) {
    return {
      family: 'each-of-weapon',
      scope: { kind: 'model' },
      capacity: null,
      modelName: null,
      rest: working.slice(eachOf[0].length).trim(),
      ...base,
    };
  }

  // "2 of this model's heavy bolters can be replaced with one of the following"
  const nOf = working.match(/^(\d+) of (?:this|the) model'?s\s+/i);
  if (nOf) {
    const capacity = Number.parseInt(nOf[1], 10);
    return {
      family: 'n-of-weapon',
      scope: { kind: 'model' },
      capacity,
      modelName: null,
      rest: working.slice(nOf[0].length).trim(),
      ...base,
    };
  }

  // "This model's Kustom Choppa can be replaced with 1 Power Klaw."
  // Апостроф обязателен: иначе правило поймает 'This model can be equipped with …',
  // где дальше идёт отдельная ветка 'this model can'.
  const possessive = working.match(/^this model's\s+/i);
  if (possessive) {
    return {
      family: 'this-model',
      scope: { kind: 'model' },
      capacity: 1,
      modelName: null,
      rest: working.slice(possessive[0].length).trim(),
      ...base,
    };
  }

  // 'This model can be equipped with 1 Watcher in the Dark.'
  const thisModelCan = working.match(/^this model\s+can\s+(?:each\s+)?/i);
  if (thisModelCan) {
    return {
      family: 'this-model',
      scope: { kind: 'model' },
      capacity: 1,
      modelName: null,
      rest: working.slice(thisModelCan[0].length).trim(),
      ...base,
    };
  }

  // 'This unit can be equipped with 1 Watcher in the Dark.'
  const thisUnitCan = working.match(/^this unit\s+can\s+(?:each\s+)?/i);
  if (thisUnitCan) {
    return {
      family: 'unit-add',
      scope: { kind: 'unit' },
      capacity: 1,
      modelName: null,
      rest: working.slice(thisUnitCan[0].length).trim(),
      ...base,
    };
  }

  // '1 model can be equipped with 1 vexilla.'
  const nModels = working.match(/^(\d+)\s+models?\s+can\s+(?:each\s+)?/i);
  if (nModels) {
    const capacity = Number.parseInt(nModels[1], 10);
    return {
      family: 'up-to-n',
      scope: { kind: 'models', count: capacity },
      capacity,
      modelName: null,
      rest: working.slice(nModels[0].length).trim(),
      ...base,
    };
  }

  // 'The Skitarii Ranger Alpha’s galvanic rifle can be replaced with 1 Mechanicus pistol.'
  // '1 model’s guardian spear can be replaced with one of the following: …'
  // 'Serpents’ neuro-disruptors can be replaced with…' (плюративный possessive).
  // Именованная модель с possessive-оружием: оружие уходит в baseText.
  const namedPossessive = working.match(
    /^(?:(\d+)\s+)?(?:the\s+)?([a-z][\w' -]*?)(?:'s|s')\s+(.+?)\s+can\s+(?:each\s+)?/i
  );
  if (namedPossessive) {
    const leading = namedPossessive[1] ? Number.parseInt(namedPossessive[1], 10) : 1;
    return {
      family: 'this-model',
      scope: { kind: 'model' },
      capacity: leading,
      modelName: stripModelWord(namedPossessive[2]),
      rest: working.slice(namedPossessive[0].length).trim(),
      baseText: namedPossessive[3],
      ...base,
    };
  }

  // 'Each model can have each shuriken cannon it is equipped with replaced with…'
  // 'Each model can be equipped with 1 Aspect Shrine token.'
  const eachModelCan = working.match(/^each model\s+can\s+(?:each\s+)?/i);
  if (eachModelCan) {
    return {
      family: 'all-models',
      scope: { kind: 'models', count: null },
      capacity: null,
      modelName: null,
      rest: working.slice(eachModelCan[0].length).trim(),
      ...base,
    };
  }

  // 'The Vespid Strain Leader can be equipped with 1 Oversight Drone.'
  // '1 Vespid Stingwing can replace its neutron blaster with 1 T’au flamer'
  const namedModel = working.match(/^(?:\d+\s+)?(?:the\s+)?([a-z][\w' -]*?)\s+can\s+(?:each\s+)?/i);
  if (namedModel) {
    const modelName = stripModelWord(namedModel[1]);
    if (modelName) {
      return {
        family: 'model-add',
        scope: { kind: 'model' },
        capacity: 1,
        modelName,
        rest: working.slice(namedModel[0].length).trim(),
        ...base,
      };
    }
  }

  return null;
}

export interface OptionParseContext {
  datasheetId: string;
  catalog: WeaponGroup[];
  /** Имена снаряжения без профиля (из доплат стоимости) — не считаются unmatched. */
  wargearNames?: Set<string>;
  /** Глобальный реестр имён снаряжения по всей базе (тоже без профиля у юнита). */
  globalWargearNames?: Set<string>;
}

/** Главная точка входа: строки Datasheets_options → правила снаряжения. */
export function parseLoadoutOptions(
  context: OptionParseContext,
  rows: OptionRow[]
): ParsedOptionsResult {
  const { datasheetId, catalog, wargearNames, globalWargearNames } = context;
  const knownNames =
    wargearNames || globalWargearNames
      ? new Set([...(wargearNames ?? []), ...(globalWargearNames ?? [])])
      : null;
  const options: LoadoutOption[] = [];
  const restrictions: string[] = [];
  const unparsed: ParsedOptionsResult['unparsed'] = [];
  let skippedNone = 0;

  for (const row of rows) {
    const line = parseIntOrNull(row.line) ?? 0;
    const raw = row.description;
    const plain = cleanText(raw);
    if (plain === '') continue;

    // Строки-ограничения помечены button='*' или начинаются со звёздочки.
    if (row.button === '*' || plain.startsWith('*')) {
      const text = plain.replace(/^\*\s*/, '').trim();
      if (text !== '') {
        restrictions.push(text);
        attachRestriction(options, text);
      }
      continue;
    }

    if (/^none$/i.test(plain)) {
      skippedNone += 1;
      continue;
    }

    const listItems = extractListItems(raw);
    const alternatives = /of the following/i.test(plain);
    const beforeList = cleanText(raw.split(/<ul/i)[0] ?? '');

    // 'If this unit contains 10 models:<ul><li>…</li><li>…</li></ul>' — каждая <li>
    // это отдельная опция, а не вариант выбора.
    const texts =
      !alternatives && listItems.length > 0
        ? listItems.map((item) =>
            collapseWhitespace(beforeList === '' ? item : `${beforeList} ${item}`)
          )
        : [plain];

    texts.forEach((text, index) => {
      const result = buildOption({
        id: `${datasheetId}:option:${line}:${index}`,
        line,
        raw,
        text,
        actionText: alternatives && beforeList !== '' ? beforeList : text,
        listItems: alternatives ? listItems : [],
        catalog,
        wargearNames: knownNames ?? undefined,
      });

      if (result.ok) options.push(result.option);
      else unparsed.push({ line, raw, reason: result.reason });
    });
  }

  return { options, restrictions, unparsed, skippedNone };
}

export interface BuildOptionInput {
  id: string;
  line: number;
  raw: string;

  /** Полный текст (нужен для определения области действия, включая условие по размеру). */
  text: string;
  /** Тот же текст без <ul>-списка — по нему определяется действие ('can be replaced with…'). */
  actionText: string;
  /** Варианты из <ul><li> — только когда это «one of the following». */
  listItems: string[];
  catalog: WeaponGroup[];
  /** Имена снаряжения без профиля (из доплат стоимости). */
  wargearNames?: Set<string>;
}

export type BuildOptionResult =
  | { ok: true; option: LoadoutOption; unmatched: string[] }
  | { ok: false; reason: string };

/** Собирает одно правило снаряжения из текста опции. */
export function buildOption(input: BuildOptionInput): BuildOptionResult {
  // Область действия определяется по тексту без <ul>-списка: иначе хвост
  // перечисления вариантов ломает разбор действия.
  const scopeMatch = matchScope(input.actionText) ?? matchScope(input.text);
  if (!scopeMatch) {
    return { ok: false, reason: `не распознана область действия: "${input.text.slice(0, 90)}"` };
  }

  const action = parseAction(scopeMatch.rest);
  if (!action) {
    return { ok: false, reason: `не распознано действие: "${scopeMatch.rest.slice(0, 90)}"` };
  }

  let capacity = scopeMatch.capacity;
  const allowDuplicates = /can take duplicates/i.test(action.resultText);
  let resultText = action.resultText
    .replace(/,\s*and can take duplicates/i, '')
    .replace(/\(\s*you cannot[^)]*\)/gi, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/:\s*$/, '')
    .trim();

  // 'one of the following:' / '1 of the following' / 'of the following' —
  // варианты лежат в <ul><li>; в самом тексте оружия нет.
  if (/^(?:\d+|one|two|three|four|five|of)\s+of the following/i.test(resultText)) {
    resultText = '';
  }

  // 'up to 4 Big Shoota' / 'up to two of the following'
  const upTo = resultText.match(
    new RegExp(`^up to\\s+${COUNT_WORD}\\s+(?:of the following|(.+?))\\.?$`, 'i')
  );
  if (upTo) {
    capacity = parseCountWord(upTo[1]) ?? capacity;
    // 'of the following' — варианты в <li>, результат в строке пуст.
    resultText = upTo[2] ?? '';
  }

  // 'one of the following:' / 'one of the following options:' / 'on of the
  // following:' (опечатка в данных) — сам указатель вариантов оружием не
  // является; список лежит в <li>.
  if (/^one? of the following(?:\s+\w+)*\s*[:*]?\s*$/i.test(resultText)) {
    resultText = '';
  }

  const baseTextRaw = action.baseText ?? scopeMatch.baseText ?? '';

  const unmatched: string[] = [];
  const choices: LoadoutChoice[] = [];

  // 'X can each be replaced with one of the following:<ul>…' — результата в строке
  // нет, варианты целиком в <li>. Непустой результат имеет приоритет над <li>.
  let resultRefs: WeaponRefsResult = { refs: [], unmatched: [] };
  if (resultText !== '') {
    resultRefs = parseWeaponRefs(resultText, input.catalog, input.wargearNames ?? null);
    unmatched.push(...resultRefs.unmatched);
    if (resultRefs.refs.length > 0) choices.push({ label: resultText, weapons: resultRefs.refs });
  }
  if (choices.length === 0) {
    for (const item of input.listItems) {
      const parsed = parseWeaponRefs(item, input.catalog, input.wargearNames ?? null);
      unmatched.push(...parsed.unmatched);
      if (parsed.refs.length > 0) choices.push({ label: item, weapons: parsed.refs });
    }
  }

  const base: WeaponRef[] = [];
  if (action.action === 'replace') {
    const parsed = parseWeaponRefs(baseTextRaw, input.catalog, input.wargearNames ?? null);
    unmatched.push(...parsed.unmatched);
    base.push(...parsed.refs);
    if (base.length === 0) {
      return { ok: false, reason: `не найдено заменяемое оружие: "${baseTextRaw}"` };
    }
  }

  if (choices.length === 0) {
    return { ok: false, reason: `не найдены варианты снаряжения: "${resultText.slice(0, 90)}"` };
  }

  return {
    ok: true,
    unmatched,
    option: {
      id: input.id,
      line: input.line,
      raw: input.raw,
      family: scopeMatch.family,
      action: action.action,
      scope: scopeMatch.scope,
      modelName: scopeMatch.modelName,
      capacity,
      perModels: scopeMatch.perModels,
      minUnitModels: scopeMatch.minUnitModels,
      condition: scopeMatch.condition,
      exclusive: input.listItems.length > 1 && !allowDuplicates,
      allowDuplicates,
      base,
      choices,
      restrictions: [],
      duplicateLimit: null,
      duplicateLimitAtSize: null,
    },
  };
}

const LIMIT_WORDS: Record<string, number> = { once: 1, twice: 2, thrice: 3 };

/** Разбирает '…no more than once/twice…', в том числе условные формы. */
export function parseDuplicateLimit(text: string): {
  limit: number | null;
  atSize: { models: number; limit: number | null } | null;
} {
  const conditional = text.match(/unless it contains\s+(\d+)\s+models[^.]*?more than\s+([a-z0-9]+)/i);
  const main = text.match(/more than\s+([a-z0-9]+)/i);

  const toLimit = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const key = raw.toLowerCase();
    if (key in LIMIT_WORDS) return LIMIT_WORDS[key];
    const parsed = Number.parseInt(key, 10);
    return Number.isNaN(parsed) ? null : parsed;
  };

  return {
    limit: toLimit(main?.[1]),
    atSize: conditional
      ? { models: Number.parseInt(conditional[1], 10), limit: toLimit(conditional[2]) }
      : null,
  };
}

/**
 * Ограничение относится к предыдущей опции, если запрещает повторять
 * один и тот же вариант ('You cannot select the same weapon…'). Прочие
 * ограничения ('Maximum 1 per model.') остаются только в списке restrictions.
 */
function attachRestriction(options: LoadoutOption[], text: string): void {
  const target = options[options.length - 1];
  if (!target) return;
  if (!/same\s+(?:weapon|option|weapon or option)/i.test(text)) return;

  target.restrictions.push(text);
  const limits = parseDuplicateLimit(text);
  target.duplicateLimit = limits.limit;
  target.duplicateLimitAtSize = limits.atSize;
}