/**
 * Нормализация кейвордов оружия.
 *
 * В базе кейворды пишутся по-разному ('Sustained Hits 1', 'SUSTAINED HITS 1',
 * 'Twin-linked'/'Twin Linked'/'TWIN-LINKED', 'LETHAL HITS: non-MONSTER/VEHICLE',
 * 'Anti-VEHICLE 4+', 'Anti-MONSTER/VEHICLE 4+'), поэтому всё приводится к
 * каноническому имени с числом/кубом и условием на кейворды цели.
 */

import { parseDice } from './dice.ts';
import type { KeywordCondition, ParsedKeyword } from './types.ts';

/** Канонические имена: префикс (в нижнем регистре) → имя. */
const CANONICAL: Array<[RegExp, string]> = [
  [/^sustained hits/, 'sustained'],
  [/^lethal hits/, 'lethal'],
  [/^devastating wounds/, 'devastating'],
  [/^rapid fire/, 'rapid-fire'],
  [/^melta/, 'melta'],
  [/^blast/, 'blast'],
  [/^cleave/, 'cleave'],
  [/^twin[- ]?linked/, 'twin-linked'],
  [/^pistol/, 'pistol'],
  [/^close[- ]?quarters/, 'close-quarters'],
  [/^heavy/, 'heavy'],
  [/^lance/, 'lance'],
  [/^extra attacks/, 'extra-attacks'],
  [/^torrent/, 'torrent'],
  [/^anti[- ]/, 'anti'],
  [/^ignores cover/, 'ignores-cover'],
  [/^indirect fire/, 'indirect'],
  [/^precision/, 'precision'],
  [/^hazardous/, 'hazardous'],
  [/^one shot/, 'one-shot'],
  [/^assault/, 'assault'],
  [/^psychic/, 'psychic'],
];

/** Разбор условия после двоеточия: 'non-MONSTER/VEHICLE' → { negate, keywords }. */
function parseCondition(text: string): KeywordCondition | null {
  const raw = text.trim();
  if (raw === '') return null;
  const negate = /^non[- ]/i.test(raw);
  const body = negate ? raw.replace(/^non[- ]/i, '') : raw;
  const keywords = body
    .split('/')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part !== '');
  if (keywords.length === 0) return null;
  return { keywords, negate };
}

/** Разбор одного кейворда ('Sustained Hits 1' → { name: 'sustained', value: 1×d1 }). */
export function parseKeyword(raw: string): ParsedKeyword | null {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text === '' || text === '-') return null;
  const lower = text.toLowerCase();

  // Условие на цель: '...: non-MONSTER/VEHICLE'.
  let condition: KeywordCondition | null = null;
  let body = lower;
  const colon = text.indexOf(':');
  if (colon > 0) {
    condition = parseCondition(text.slice(colon + 1));
    body = lower.slice(0, colon).trim();
  }

  const namePair = CANONICAL.find(([pattern]) => pattern.test(body));
  const keyword: ParsedKeyword = {
    name: namePair ? namePair[1] : body.replace(/\s+/g, '-'),
    raw: text,
    value: null,
    target: null,
    condition,
  };

  // Значение X: последний токен ('sustained hits 1', 'rapid fire d6+3').
  const tail = /^(.*?)(?:\s(\S+))?$/.exec(body);
  if (tail && tail[2] !== undefined && /^([+-]?\d+|d\d+([+-]\d+)?|\d*d\d+([+-]\d+)?)$/.test(tail[2])) {
    keyword.value = parseDice(tail[2].toUpperCase());
  }

  // ANTI-X Y+: цель — X, критическое ранение — Y+.
  if (keyword.name === 'anti') {
    const anti = /^anti[- ](.+?)\s(\d+)\+$/.exec(body);
    if (anti) {
      keyword.target = anti[1]
        .split('/')
        .map((part) => part.trim().toUpperCase())
        .filter((part) => part !== '');
      keyword.value = parseDice(`${anti[2]}`);
    }
  }

  // Blast/Cleave без X = 1 доп. дайс за каждые 5 моделей.
  if ((keyword.name === 'blast' || keyword.name === 'cleave') && keyword.value === null) {
    keyword.value = parseDice('1');
  }

  return keyword;
}

/**
 * Ключ дедупликации: два кейворда считаются одним и тем же, если совпадают
 * каноническое имя И цель.
 *
 * Одного имени мало для [ANTI-X Y+]: у одного ствола бывает сразу
 * «Anti-MONSTER 4+» и «Anti-VEHICLE 3+», и это РАЗНЫЕ правила — второе
 * срабатывает против техники. Схлопывание по имени теряло Anti-VEHICLE
 * целиком, оставляя только Anti-MONSTER.
 */
function dedupeKey(keyword: ParsedKeyword): string {
  return keyword.target === null
    ? keyword.name
    : `${keyword.name}:${[...keyword.target].sort().join('/')}`;
}

/** Массовый разбор списка кейвордов. */
export function parseKeywords(raw: string[]): ParsedKeyword[] {
  const seen = new Map<string, ParsedKeyword>();
  for (const item of raw) {
    const keyword = parseKeyword(item);
    if (keyword === null) continue;
    // Дубликаты с разным регистром склеиваем; более сильное значение побеждает
    // (упрощение: Sustained Hits 1 + SUSTAINED HITS 2 → 2).
    const key = dedupeKey(keyword);
    const existing = seen.get(key);
    if (
      !existing ||
      (keyword.value !== null && (existing.value === null || keyword.value.count > existing.value.count))
    ) {
      seen.set(key, keyword);
    }
  }
  return [...seen.values()];
}

/**
 * Применим ли кейворд к цели с данными кейвордами — проверка ЕГО условия.
 *
 * В отличие от `keywordOf`, который возвращает первое подходящее совпадение,
 * эта функция отвечает на вопрос про конкретный экземпляр кейворда. Это нужно
 * там, где правило перебирает несколько кейвордов одного оружия: например
 * [ANTI-MONSTER 4+] и [ANTI-VEHICLE 3+] у одного ствола применяются независимо,
 * и `keywordOf` вернул бы только Anti-MONSTER, пропустив второе условие.
 *
 * @param defenderKeywords кейворды отряда и модели цели (вместе)
 */
export function keywordApplies(
  keyword: ParsedKeyword,
  defenderKeywords?: string[]
): boolean {
  if (keyword.condition === null || defenderKeywords === undefined) return true;
  const has = keyword.condition.keywords.some((required) =>
    defenderKeywords.includes(required)
  );
  return keyword.condition.negate ? !has : has;
}

/** Кейворд по каноническому имени, с учётом условия на кейворды цели. */
export function keywordOf(
  keywords: ParsedKeyword[],
  name: string,
  defenderKeywords?: string[]
): ParsedKeyword | null {
  for (const keyword of keywords) {
    if (keyword.name !== name) continue;
    if (keywordApplies(keyword, defenderKeywords)) return keyword;
  }
  return null;
}
