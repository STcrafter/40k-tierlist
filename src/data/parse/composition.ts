/**
 * Разбор Datasheets_unit_composition → группы моделей отряда.
 *
 * Реальные форматы строк (проверено на выгрузке):
 *   '1 Warboss model'
 *   '1-2 Nob models' / '9-18 Boy models' / '10-20 Gretchin models'
 *   '4-8 Burna Boyz' / '1-2 Spanners' / '4-9 Lootas'
 *   '1 Venerable Land Raider'                       (без слова model)
 *   '1 Kaptin Badrukk – EPIC HERO'                  (хвост с ключевыми словами)
 * Аномалии (14 строк): 'One of the following:', 'OR', 'or:',
 * 'This unit can contain a maximum of 10 models.' — они не описывают модель
 * и попадают в anomalies (в отчёте видны, юнит не ломают).
 *
 * Сопоставление с Datasheets_models идёт по имени (см. normalize/match.ts),
 * потому что порядок строк в этих двух файлах не совпадает.
 */

import type { CompositionRow } from '../raw/types.ts';
import { cleanText, collapseWhitespace, stripDashTail, stripTrailingWord } from '../normalize/text.ts';
import { parseIntOrNull } from '../normalize/numbers.ts';
import { scoreNameMatch } from '../normalize/match.ts';
import type { ModelGroup, ModelProfile } from '../types/unit.ts';

export interface CompositionLine {
  line: number;
  /** Исходная подпись после нормализации: '1-2 Nob models'. */
  label: string;
  /** Имя модели без количества и слова models: 'Nob', 'Burna Boyz'. */
  name: string;
  minCount: number;
  maxCount: number;
}

export interface ParsedComposition {
  lines: CompositionLine[];
  anomalies: Array<{ line: number; description: string }>;
}

export function parseCompositionLines(rows: CompositionRow[]): ParsedComposition {
  const lines: CompositionLine[] = [];
  const anomalies: Array<{ line: number; description: string }> = [];

  for (const row of rows) {
    const line = parseIntOrNull(row.line) ?? 0;
    const text = collapseWhitespace(stripDashTail(cleanText(row.description)));
    const match = text.match(/^(\d+)\s*(?:[-–—]\s*(\d+))?\s+(.+)$/);

    if (!match) {
      anomalies.push({ line, description: row.description });
      continue;
    }

    const minCount = Number.parseInt(match[1], 10);
    const maxCount = match[2] ? Number.parseInt(match[2], 10) : minCount;
    const rest = stripTrailingWord(match[3].trim(), 'models');

    if (rest === '') {
      anomalies.push({ line, description: row.description });
      continue;
    }

    lines.push({ line, label: text, name: rest, minCount, maxCount });
  }

  return { lines, anomalies };
}

export interface BuildModelGroupsResult {
  groups: ModelGroup[];
  /** Подписи состава, которым не нашлось модели. */
  unmatched: string[];
}

/**
 * Ранговые слова в конце имени: у таких моделей-лидеров часто НЕТ собственной
 * строки в Datasheets_models ('1 Skitarii Ranger Alpha' при профиле 'Skitarii
 * Rangers'), поэтому при неудачном прямом сопоставлении пробуем имя без них.
 */
const RANK_WORDS = new Set([
  'alpha',
  'superior',
  'princeps',
  'sergeant',
  'prime',
  'exemplar',
]);

/** 'Skitarii Ranger Alpha' → 'Skitarii Ranger'; 'Prosecutor Sister Superior' → 'Prosecutor Sister'. */
export function stripRankWords(name: string): string {
  const words = name.split(/\s+/);
  while (words.length > 1 && RANK_WORDS.has((words[words.length - 1] ?? '').toLowerCase())) {
    words.pop();
  }
  return words.join(' ');
}

/**
 * Сопоставляет строки состава с профилями моделей.
 * Используется «жадное назначение по убыванию скора», а не порядок строк —
 * иначе смешанные отряды (Nob+Boy, Spanner+Burna Boyz) разъезжаются.
 *
 * Особый случай: строки-лидеры ('1 Skitarii Ranger Alpha' + '9 Skitarii
 * Rangers') описывают ОДНУ и ту же модель, а в Datasheets_models профиль один.
 * Поэтому профиль разрешается использовать повторно, если у строки нет
 * свободного сопоставимого профиля с сопоставимым скором.
 */
export function buildModelGroups(
  datasheetId: string,
  lines: CompositionLine[],
  profiles: ModelProfile[]
): BuildModelGroupsResult {
  const unmatched: string[] = [];

  // Для каждой строки — полный список профилей по убыванию скора. Второй проход
  // с именем без ранговых слов добавляет запасные варианты ('… Alpha' → '…').
  const ranked: Array<Array<{ profileIndex: number; score: number }>> = lines.map((line) => {
    const scored = profiles
      .map((profile, profileIndex) => ({
        profileIndex,
        score: scoreNameMatch(line.name, profile.name),
      }))
      .filter((entry) => entry.score >= 0.8);
    scored.sort((a, b) => b.score - a.score || a.profileIndex - b.profileIndex);

    const stripped = stripRankWords(line.name);
    if (stripped !== line.name) {
      for (const entry of scored) entry.score *= 0.99;
      const strippedScored = profiles
        .map((profile, profileIndex) => ({ profileIndex, score: scoreNameMatch(stripped, profile.name) }))
        .filter((entry) => entry.score >= 0.8);
      strippedScored.sort((a, b) => b.score - a.score || a.profileIndex - b.profileIndex);
      for (const entry of strippedScored) {
        const scaled = { profileIndex: entry.profileIndex, score: entry.score * 0.98 };
        const existing = scored.find((e) => e.profileIndex === entry.profileIndex);
        if (existing) existing.score = Math.max(existing.score, scaled.score);
        else scored.push(scaled);
      }
      scored.sort((a, b) => b.score - a.score || a.profileIndex - b.profileIndex);
    }

    return scored;
  });

  // Жадное назначение: строки с более уверенным матчем выбирают первыми.
  const order = lines
    .map((_, index) => index)
    .sort((a, b) => (ranked[b][0]?.score ?? 0) - (ranked[a][0]?.score ?? 0) || a - b);

  const assignedLine = new Map<number, { profileIndex: number; score: number }>();
  const usedProfiles = new Set<number>();

  for (const lineIndex of order) {
    const options = ranked[lineIndex];
    if (options.length === 0) continue;

    // Сначала первый свободный профиль; если свободных нет — разрешаем
    // совместное использование лучшего профиля (лидер и отряд одного типа).
    const free = options.find((option) => !usedProfiles.has(option.profileIndex));
    const chosen = free ?? options[0];
    usedProfiles.add(chosen.profileIndex);
    assignedLine.set(lineIndex, chosen);
  }

  // Запасная эвристика для строк без матча ≥ 0.8 ('1 Sybarite' при единственном
  // профиле 'Ynnari Kabalite Warriors'): если у юнита один профиль — вся строка
  // относится к нему; если несколько — берём уникального кандидата ≥ 0.6.
  const fuzzy = lines.map((line) => {
    const scored = profiles
      .map((profile, profileIndex) => ({ profileIndex, score: scoreNameMatch(line.name, profile.name) }))
      .filter((entry) => entry.score >= 0.6);
    scored.sort((a, b) => b.score - a.score || a.profileIndex - b.profileIndex);
    return scored;
  });

  // Запасная эвристика для строк без матча ≥ 0.8:
  //  - если у юнита единственный профиль — вся строка относится к нему
  //    ('1 Sybarite' при профиле 'Ynnari Kabalite Warriors');
  //  - иначе — уникальный кандидат со скором ≥ 0.6 ('Voidreaver Felarch' при
  //    профиле 'Corsair Voidreavers').
  const singleProfile = profiles.length === 1;

  lines.forEach((_line, index) => {
    if (assignedLine.has(index)) return;
    if (singleProfile && profiles.length > 0) {
      assignedLine.set(index, { profileIndex: 0, score: 0.5 });
      return;
    }
    const scored = fuzzy[index];
    if (scored.length === 0) return;
    const tied = scored.filter((entry) => entry.score === scored[0].score);
    if (tied.length !== 1) return;
    assignedLine.set(index, { ...scored[0], score: scored[0].score * 0.6 });
  });

  const groups: ModelGroup[] = lines.map((line, index) => {
    const assignment = assignedLine.get(index);
    const profile = assignment ? profiles[assignment.profileIndex] : null;
    if (!profile) unmatched.push(line.label);

    return {
      id: `${datasheetId}:group:${index}`,
      label: line.label,
      labelName: line.name,
      minCount: line.minCount,
      maxCount: line.maxCount,
      profile,
      profileName: profile ? profile.name : null,
      matchScore: assignment ? assignment.score : 0,
      abilities: [],
      wargear: [],
    };
  });

  return { groups, unmatched };
}

/**
 * Раскладывает размер отряда по группам моделей.
 *
 * Правило: сначала выполняются минимумы состава, затем «лишние» модели
 * распределяются по группам с запасом до максимума (по порядку групп).
 * Проверка на реальных данных: Boyz (1-2 Nob + 9-18 Boy) → 10 = 1 Nob + 9 Boy,
 * 20 = 2 Nob + 18 Boy, что совпадает с вариантами в Datasheets_models_cost.
 */
export function splitModelCounts(groups: ModelGroup[], size: number): number[] {
  const counts = groups.map((group) => group.minCount);
  let remaining = size - counts.reduce((sum, value) => sum + value, 0);

  while (remaining > 0) {
    let progressed = false;
    for (let index = 0; index < groups.length && remaining > 0; index += 1) {
      if (counts[index] < groups[index].maxCount) {
        counts[index] += 1;
        remaining -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }

  // Размер больше суммы максимумов — излишек отдаём первой группе (в отчёте это
  // будет видно как расхождение с максимумом состава).
  if (remaining > 0 && counts.length > 0) counts[0] += remaining;

  return counts;
}