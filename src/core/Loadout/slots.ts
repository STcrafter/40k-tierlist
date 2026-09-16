// src/core/loadout/slots.ts

export interface LoadoutSlot {
  id: string;
  kind: 'replace-exclusive' | 'replace-count' | 'add-count' | 'add-exclusive';
  capacity: number;          // сколько моделей могут взять
  baseWeapon: string | null; // группа базового оружия, которое заменяем
  choices: string[];         // нормализованные имена из каталога
}

/**
 * Парсит текст Datasheets_options в слоты.
 * Поддерживаемые паттерны:
 *  - "The X's <base> can be replaced with one of the following: <li>..."
 *  - "Every model's <base> can be replaced with one of the following: ..."
 *  - "For every N models, 1 model equipped with <base> can be equipped with 1 <W>"
 *  - "Can be equipped with one of the following: <li>..."  (добавление)
 */
export function parseSlots(
  optionDescriptions: string[],
  models: number,
  normalize: (name: string) => string,
  catalogNames: Set<string>
): LoadoutSlot[] {
  const slots: LoadoutSlot[] = [];

  optionDescriptions.forEach((desc, idx) => {
    const plain = desc.replace(/<[^>]+>/g, ' ');
    const choices = extractLi(desc).map(normalize).filter((c) => catalogNames.has(c));

    // "For every 5 models ... 1 model equipped with X can be equipped with 1 Y"
    const perModels = plain.match(
      /for every (\d+) models?[\s\S]{0,80}?(\d+) model[\s\S]{0,60}?(?:equipped with|carrying)\s+(?:1\s+)?([a-z0-9' -]+?)\s+can be (?:equipped with|replaced)/i
    );
    if (perModels) {
      const every = parseInt(perModels[1], 10);
      const base = normalize(perModels[3]);
      const added = extractTrailingWeapon(plain, normalize, catalogNames);
      slots.push({
        id: `slot-${idx}`,
        kind: 'replace-count',
        capacity: Math.floor(models / every),
        baseWeapon: base,
        choices: added ? [added] : choices,
      });
      return;
    }

    // "The/Every model's <base> can be replaced with one of the following"
    const replace = plain.match(
      /(every model'?s?|the [a-z ]+?'s|1 model'?s?)\s+([a-z0-9' -]+?)\s+can be replaced with one of/i
    );
    if (replace) {
      const quantor = replace[1].toLowerCase();
      const capacity = quantor.startsWith('every') ? models : 1;
      slots.push({
        id: `slot-${idx}`,
        kind: 'replace-exclusive',
        capacity,
        baseWeapon: normalize(replace[2]),
        choices,
      });
      return;
    }

    // "can be equipped with one of the following" — добавление, эксклюзивно
    if (/can be equipped with one of the following/i.test(plain)) {
      slots.push({
        id: `slot-${idx}`,
        kind: 'add-exclusive',
        capacity: 1,
        baseWeapon: null,
        choices,
      });
      return;
    }

    // "For every N models ... can be equipped with" без замены — добавление с лимитом
    const addPer = plain.match(/for every (\d+) models?[\s\S]{0,100}?can be equipped with/i);
    if (addPer) {
      const added = extractTrailingWeapon(plain, normalize, catalogNames);
      slots.push({
        id: `slot-${idx}`,
        kind: 'add-count',
        capacity: Math.floor(models / parseInt(addPer[1], 10)),
        baseWeapon: null,
        choices: added ? [added] : choices,
      });
      return;
    }
  });

  return slots;
}

function extractLi(desc: string): string[] {
  const out: string[] = [];
  const re = /<li>\s*(?:\d+\s+)?([^<]+?)\s*<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(desc)) !== null) out.push(m[1]);
  return out;
}

function extractTrailingWeapon(
  plain: string,
  normalize: (s: string) => string,
  catalog: Set<string>
): string | null {
  const m = plain.match(/(?:equipped with|take|be equipped with)\s+(?:1\s+)?([a-z0-9' -]+?)\.?$/i);
  if (!m) return null;
  const name = normalize(m[1]);
  return catalog.has(name) ? name : null;
}