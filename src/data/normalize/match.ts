/**
 * Сопоставление имён Wahapedia (состав отряда ↔ строки моделей, опции ↔ каталог оружия).
 *
 * Проблема: в данных нет общего ключа между `Datasheets_unit_composition`
 * и `Datasheets_models` — порядок строк не совпадает, а написания различаются:
 *   состав: '1-2 Spanners',      модели: 'Spanner'
 *   состав: '9-18 Boy models',   модели: 'Boy'
 *   состав: '4-8 Burna Boyz',    модели: 'Burna Boy'
 * Поэтому используется скоринг с вариантами имени (множественное число, 'z' → 's')
 * и токенным пересечением, с порогом уверенности.
 */

import { slug } from './text.ts';

/** Примитивная нормализация множественного числа последнего слова. */
export function singularize(slugged: string): string {
  const words = slugged.split(' ');
  const index = words.length - 1;
  const last = words[index] ?? '';
  let singular = last;

  if (/(s|x|z|ch|sh)es$/.test(last)) singular = last.replace(/es$/, '');
  else if (/ies$/.test(last)) singular = last.replace(/ies$/, 'y');
  else if (/s$/.test(last) && !/ss$/.test(last)) singular = last.replace(/s$/, '');
  else if (/z$/.test(last)) singular = last.replace(/z$/, '');

  words[index] = singular;
  return words.join(' ');
}

/**
 * Ядро имени без количественной части и слова model(s):
 *   '1-2 Spanners'    → 'spanners'
 *   '9-18 Boy models' → 'boy'
 *   '4-8 Burna Boyz'  → 'burna boyz'
 */
export function coreSlug(input: string): string {
  return slug(input)
    .replace(/^\d+(\s+\d+)?\s+/, '')
    .replace(/\b(model|models)\b/g, '')
    .replace(/^(?:the|a|an)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Префиксное совпадение с границей слова: 'veteran squad' ~ 'veteran'. */
function startsWithWord(a: string, b: string): boolean {
  return a !== b && b !== '' && a.startsWith(`${b} `);
}

/** Варианты написания: 'Burna Boyz' → ['burna boyz', 'burna boy', 'burna boys']. */
export function nameVariants(input: string): string[] {
  const base = coreSlug(input);
  const variants = new Set<string>([base]);
  variants.add(singularize(base));

  const withoutTailZ = base.replace(/z\b/g, '');
  if (withoutTailZ !== base) {
    variants.add(withoutTailZ);
    variants.add(singularize(withoutTailZ));
  }

  return [...variants].filter((v) => v.length > 0);
}

function tokenOverlap(a: string, b: string): number {
  const norm = (input: string): Set<string> =>
    new Set(
      input
        .split(' ')
        .filter((token) => token.length > 1)
        .map((token) => singularize(token))
    );
  const left = norm(a);
  const right = norm(b);
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
}

/** 1 — точное совпадение, 0 — ничего общего. */
export function scoreNameMatch(target: string, candidate: string): number {
  const t = coreSlug(target);
  const c = coreSlug(candidate);
  if (!t || !c) return 0;
  if (t === c) return 1;

  const variants = nameVariants(target);
  const candidateVariants = nameVariants(candidate);
  if (variants.some((v) => candidateVariants.includes(v))) return 0.95;

  const prefixHit =
    variants.some((v) => startsWithWord(v, c) || startsWithWord(c, v)) ||
    candidateVariants.some((v) => startsWithWord(v, t) || startsWithWord(t, v));
  if (prefixHit) return 0.8;

  const overlap = tokenOverlap(t, c);
  return overlap >= 0.5 ? 0.5 + overlap * 0.3 : overlap * 0.5;
}

export interface NameMatch<T> {
  item: T;
  index: number;
  score: number;
}

/**
 * Лучший матч среди кандидатов. Возвращает null, если уверенности недостаточно
 * (низкий скор или два кандидата почти равны) — лучше явная «дырка» в отчёте,
 * чем молчаливая подстановка неверной модели.
 */
export function matchByName<T>(
  target: string,
  candidates: T[],
  nameOf: (item: T) => string,
  minScore = 0.8
): NameMatch<T> | null {
  const scored: Array<NameMatch<T>> = candidates.map((item, index) => ({
    item,
    index,
    score: scoreNameMatch(target, nameOf(item)),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const best = scored[0];
  if (!best) return null;

  const runnerUp = scored[1]?.score ?? 0;
  const confident = best.score >= minScore && (best.score >= 0.95 || best.score - runnerUp >= 0.15);
  return confident ? best : null;
}
