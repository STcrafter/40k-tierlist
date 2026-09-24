/**
 * Разбор Datasheets_wargear → каталог групп оружия со ВСЕМИ профилями.
 *
 * В датасете одна единица оружия может иметь несколько строк-профилей:
 *   'Kombi-rokkit - Busta Rokkit' / 'Kombi-rokkit - Shoota'   (разделитель ' - ')
 *   'Kannon – frag' / 'Kannon – shell'                        (разделитель ' – ')
 *   'Da Rippa – standard' / 'Da Rippa – supercharge'
 * Колонка line_in_wargear сбрасывается в 1 на первом профиле оружия.
 *
 * Семантика «комбинированный режим» vs «альтернативный режим» НЕ выводится:
 * в данных разделитель не кодирует это однозначно ('Kustom Shoota - Aimed' —
 * альтернатива, а 'Kombi-rokkit - Shoota' — второй ствол комбиоружия), поэтому
 * сохраняется только фактическая информация: variant + separator.
 */

import type { WargearRow } from '../raw/types.ts';
import { cleanText, slug } from '../normalize/text.ts';
import {
  parseArmourPenetration,
  parseDice,
  parseIntOrNull,
  parseRange,
  parseSkill,
} from '../normalize/numbers.ts';
import type { WeaponGroup, WeaponKeyword, WeaponProfile } from '../types/unit.ts';

/**
 * Известные правила оружия (11-я ред.). Ключ — канонический uppercase-текст
 * правила без параметров. Всё, что не найдено здесь, попадает в
 * issues.unknownWeaponKeywords и уточняется по отчёту парсера.
 */
export const WEAPON_KEYWORDS: readonly string[] = [
  'ANTI-BEAST',
  'ANTI-CHARACTER',
  'ANTI-DAEMON',
  'ANTI-FLY',
  'ANTI-INFANTRY',
  'ANTI-MONSTER',
  'ANTI-MOUNTED',
  'ANTI-PSYKER',
  'ANTI-SWARM',
  'ANTI-TITANIC',
  'ANTI-VEHICLE',
  'ANTI-WALKER',
  'ASSAULT',
  'BLAST',
  'CLEAVE',
  'CONVERSION',
  'DEVASTATING WOUNDS',
  'EXTRA ATTACKS',
  'HAZARDOUS',
  'HEAVY',
  'IGNORES COVER',
  'IMPACT',
  'INDIRECT FIRE',
  'LANCE',
  'LETHAL HITS',
  'LINKED FIRE',
  'MELTA',
  'ONE SHOT',
  'PISTOL',
  'PRECISION',
  'PSYCHIC',
  'RAPID FIRE',
  'SUSTAINED HITS',
  'TORRENT',
  'TWIN-LINKED',
  'TWIN LINKED',
  'TWINNED',
];

export interface WeaponNameParts {
  weaponName: string;
  variant: string | null;
  separator: 'space-dash' | 'en-dash' | null;
}

/** 'Kombi-rokkit - Busta Rokkit' → { weaponName: 'Kombi-rokkit', variant: 'Busta Rokkit' }. */
export function splitWeaponName(rawName: string): WeaponNameParts {
  const name = cleanText(rawName);
  const match = name.match(/^(.*?)\s+([-–—])\s+(.+)$/);
  if (!match) return { weaponName: name, variant: null, separator: null };

  const [, head, dash, tail] = match;
  return {
    weaponName: head.trim(),
    variant: tail.trim(),
    separator: dash === '-' ? 'space-dash' : 'en-dash',
  };
}

function longestKeywordPrefix(upperToken: string): string | null {
  let best: string | null = null;
  for (const key of WEAPON_KEYWORDS) {
    if (!upperToken.startsWith(key)) continue;
    const next = upperToken.charAt(key.length);
    if (next !== '' && !/[\s:\d+*-]/.test(next) && next !== 'D') continue;
    if (!best || key.length > best.length) best = key;
  }
  return best;
}

/** 'RAPID FIRE 2' → { key: 'RAPID FIRE', value: '2' }; неизвестное → known: false. */
export function parseWeaponKeywordToken(rawToken: string): WeaponKeyword {
  const token = rawToken.trim();
  const upper = token.toUpperCase();
  const key = longestKeywordPrefix(upper);

  if (!key) {
    return { key: upper, value: null, note: null, raw: token, known: false };
  }

  const restRaw = token.slice(key.length).trim().replace(/^[:\s]+/, '');
  const valueMatch = restRaw.match(/^(\d+\+|D\d+(?:[+-]\d+)?|\d+)/i);
  const value = valueMatch ? valueMatch[1].toUpperCase() : null;
  const note = (valueMatch ? restRaw.slice(valueMatch[0].length) : restRaw)
    .replace(/^[:\s]+/, '')
    .trim();

  return {
    key,
    value,
    note: note !== '' ? note : null,
    raw: token,
    known: true,
  };
}

export function parseWeaponKeywords(description: string | null | undefined): WeaponKeyword[] {
  const cleaned = cleanText(description ?? '');
  if (cleaned === '' || /^none$/i.test(cleaned)) return [];
  return cleaned
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map(parseWeaponKeywordToken);
}

export function parseWeaponProfile(row: WargearRow): WeaponProfile {
  const parts = splitWeaponName(row.name);
  const keywords = parseWeaponKeywords(row.description);
  const skill = parseSkill(row.BS_WS);
  const type = row.type === '' ? null : /^melee$/i.test(row.type) ? 'melee' : 'ranged';

  return {
    id: `${row.datasheet_id}:wargear:${row.line}`,
    name: cleanText(row.name),
    weaponName: parts.weaponName,
    variant: parts.variant,
    separator: parts.separator,
    type,
    range: parseRange(row.range),
    attacks: parseDice(row.A),
    skill,
    strength: parseIntOrNull(row.S),
    armourPenetration: parseArmourPenetration(row.AP),
    damage: parseDice(row.D),
    keywords,
    autoHit: skill === null || keywords.some((keyword) => keyword.key === 'TORRENT'),
    rawDescription: row.description === '' ? null : cleanText(row.description),
    dice: row.dice === '' ? null : row.dice,
  };
}

export interface WeaponCatalogResult {
  groups: WeaponGroup[];
  profiles: WeaponProfile[];
  /** Правила оружия, которых нет в WEAPON_KEYWORDS. */
  unknownKeywords: string[];
}

/** Строит каталог: профили одного оружия (по имени без варианта) объединяются в группу. */
export function buildWeaponCatalog(rows: WargearRow[]): WeaponCatalogResult {
  const groups: WeaponGroup[] = [];
  const byId = new Map<string, WeaponGroup>();
  const profiles: WeaponProfile[] = [];
  const unknown = new Set<string>();

  for (const row of rows) {
    const profile = parseWeaponProfile(row);
    profiles.push(profile);

    for (const keyword of profile.keywords) {
      if (!keyword.known) unknown.add(keyword.key);
    }

    const groupId = slug(profile.weaponName);
    let group = byId.get(groupId);
    if (!group) {
      group = { id: groupId, name: profile.weaponName, profiles: [] };
      byId.set(groupId, group);
      groups.push(group);
    }
    group.profiles.push(profile);
  }

  return { groups, profiles, unknownKeywords: [...unknown] };
}

/** Ищет группу оружия по имени из текста опции (устойчиво к регистру и вариантам). */
export function findWeaponGroup(groups: WeaponGroup[], name: string): WeaponGroup | null {
  const target = slug(name);
  if (target === '') return null;

  const exact = groups.find((group) => slug(group.name) === target);
  if (exact) return exact;

  const profileHit = groups.find((group) =>
    group.profiles.some(
      (profile) => slug(profile.name) === target || slug(profile.variant ?? '') === target
    )
  );
  if (profileHit) return profileHit;

  const singularTarget = target.replace(/z\b/g, '');
  return (
    groups.find((group) => {
      const candidate = slug(group.name);
      return (
        candidate.startsWith(target) ||
        target.startsWith(candidate) ||
        candidate === singularTarget
      );
    }) ?? null
  );
}