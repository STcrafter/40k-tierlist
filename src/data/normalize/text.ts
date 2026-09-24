/**
 * Нормализация текста Wahapedia: HTML, типографика, слаг-имена.
 *
 * В данных встречаются:
 * - HTML-разметка (`<b>`, `<ul class="dsUlC">`, `<span class="kwb">`);
 * - типографские апострофы `’` (This model’s) и дефисы `–`/`—`;
 * - ключевые слова внутри span'ов (ADEPTUS CUSTODES INFANTRY);
 * - конструкции вида `1 Kaptin Badrukk – EPIC HERO` в составе отряда.
 */

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&mdash;': '—',
  '&ndash;': '–',
};

export function decodeEntities(input: string): string {
  return input.replace(/&[a-z#0-9]+;/gi, (match) => ENTITIES[match.toLowerCase()] ?? match);
}

/** Удаляет HTML-теги, декодирует сущности, схлопывает пробелы. */
export function stripHtml(input: string): string {
  if (!input) return '';
  const withoutTags = input.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ');
  return collapseWhitespace(decodeEntities(withoutTags));
}

/** Приводит типографику к ASCII: ’ ‘ ` → ', – — → -. */
export function normalizeTypography(input: string): string {
  return input.replace(/[’‘`´]/g, "'").replace(/[–—]/g, '-');
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/** Полная «человеческая» нормализация: HTML + типографика + пробелы. */
export function cleanText(input: string): string {
  return normalizeTypography(stripHtml(input));
}

/** Слаговое имя для сопоставления: 'Burna Boyz' → 'burna boyz'. */
export function slug(input: string): string {
  return normalizeTypography(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Отрезает хвост вида ' – EPIC HERO' или ' - EPIC HERO' (даш/дефис в окружении
 * пробелов). Применяется к подписям состава отряда, где Wahapedia дописывает
 * ключевые слова после имени модели. Имена моделей/оружия в датасете дефис
 * без пробелов не содержат, поэтому риск ложного отрезания минимален.
 */
export function stripDashTail(input: string): string {
  return input.split(/\s+[-–—]\s+/)[0].trim();
}

/** Убирает завершающее слово (например, 'models') и хвостовую точку. */
export function stripTrailingWord(input: string, word: string): string {
  const re = new RegExp(`\\s+${word}\\.?$`, 'i');
  return input.replace(re, '').trim();
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** 'two' → 2, '4' → 4, иначе null. */
export function parseCountWord(value: string): number | null {
  const trimmed = value.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return NUMBER_WORDS[trimmed] ?? null;
}

/** Разбирает список элементов, разделённых ';', ',', ' and ', ' or '. */
export function splitListItems(input: string): string[] {
  return input
    .split(/;|,|\band\b|\bor\b/gi)
    .map((part) => collapseWhitespace(part))
    .filter((part) => part.length > 0);
}
