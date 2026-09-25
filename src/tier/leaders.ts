/**
 * Лидеры и support-юниты: применимые бонусы к отряду.
 *
 * BSData хранит бонусы в тексте способностей (`Leader`, `Support`, `Aura`),
 * а не в структурированном виде. Разбор ниже консервативный: он извлекает
 * только модификаторы, которые поддерживает наш симулятор.
 */

import { parseKeywords } from '../combat/keywords.ts';
import type { CombatUnit, ParsedKeyword } from '../combat/types.ts';
import type { BsAbility, BsDatasheet } from '../bsdata/types.ts';
import { adaptUnit } from '../combat/adapter.ts';
import { isEligibleForCalculations } from '../combat/budget.ts';

export interface LeaderBonuses {
  toughness: number;
  wounds: number;
  save: number;
  invuln: number;
  leadership: number;
  objectiveControl: number;
  weaponAttacks: number;
  weaponSkill: number;
  weaponStrength: number;
  weaponDamage: number;
  weaponKeywords: string[];
  rerollHitOn: number[];
  rerollWoundOn: number[];
  rerollSaveOn: number[];
}

export interface LeaderDefinition {
  id: string;
  name: string;
  faction: string;
  factions: string[];
  points: number;
  keywords: string[];
  allowedUnitIds: string[];
  bonuses: LeaderBonuses;
  abilities: Array<{ name: string; description: string }>;
  unit: CombatUnit;
}

const emptyBonuses = (): LeaderBonuses => ({
  toughness: 0, wounds: 0, save: 0, invuln: 0, leadership: 0,
  objectiveControl: 0, weaponAttacks: 0, weaponSkill: 0, weaponStrength: 0,
  weaponDamage: 0, weaponKeywords: [], rerollHitOn: [], rerollWoundOn: [], rerollSaveOn: [],
});

function unique<T>(values: T[]): T[] { return [...new Set(values)]; }
function numberAfter(text: string, expression: RegExp): number {
  const match = expression.exec(text);
  return match ? Number(match[1]) : 0;
}
function clean(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\^\^/g, '')
    .replace(/[•■]/g, ' ')
    .replace(/\\u[0-9a-f]{4}/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function isAttachmentAbility(ability: BsAbility): boolean {
  return /^(leader|support)$/i.test(ability.name) && /attach|following unit|following units/i.test(ability.description);
}
function allowedUnitsOf(ability: BsAbility, allDatasheets: BsDatasheet[]): string[] {
  const text = clean(ability.description).toLowerCase();
  if (!isAttachmentAbility(ability)) return [];
  return allDatasheets
    .filter((candidate) => {
      const name = clean(candidate.name).toLowerCase();
      return name.length >= 4 && text.includes(name);
    })
    .map((candidate) => candidate.id);
}

/** Собирает leader/support-юниты, пригодные для отдельной вкладки. */
export function leaderDefinitionsOf(datasheets: BsDatasheet[]): LeaderDefinition[] {
  const leaders: LeaderDefinition[] = [];
  for (const datasheet of datasheets) {
    const attachmentAbilities = datasheet.abilities.filter(isAttachmentAbility);
    if (!datasheet.keywords.some((keyword) => /^(leader|support)$/i.test(keyword)) && attachmentAbilities.length === 0) continue;
    const adapted = adaptUnit(datasheet, { size: 'min' });
    if (adapted.unit.models.length === 0 || !isEligibleForCalculations(datasheet.name, adapted.points)) continue;
    const allowedUnitIds = unique(attachmentAbilities.flatMap((ability) => allowedUnitsOf(ability, datasheets)));
    if (allowedUnitIds.length === 0) continue;
    leaders.push({
      id: datasheet.id,
      name: datasheet.name,
      faction: datasheet.faction,
      factions: datasheet.factions,
      points: adapted.points,
      keywords: datasheet.keywords,
      allowedUnitIds,
      bonuses: leaderBonusesOf(datasheet),
      abilities: datasheet.abilities.map((ability) => ({ name: ability.name, description: ability.description })),
      unit: adapted.unit,
    });
  }
  return leaders;
}
function characteristicBonus(text: string, name: string): number {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return numberAfter(text, new RegExp(`(?:add|improve)\\s+([+-]?\\d+)\\s+to\\s+(?:the\\s+)?${safe}\\b`, 'i'));
}
function weaponKeywordsOf(text: string): string[] {
  return unique([...text.matchAll(/\[([^\]]+)\]/g)].map((match) => clean(match[1])));
}
function rerollValues(text: string, kind: 'hit' | 'wound' | 'save'): number[] {
  const expression = new RegExp(`re[- ]?roll(?:ed|s)?[^.]{0,90}${kind}\\s+roll(?:\\s+of)?\\s+(\\d+)`, 'gi');
  return unique([...text.matchAll(expression)].map((match) => Number(match[1])));
}

/** Консервативный разбор бонусов лидера. */
export function leaderBonusesOf(datasheet: BsDatasheet): LeaderBonuses {
  const bonuses = emptyBonuses();
  const texts = [...datasheet.abilities, ...datasheet.rules]
    .filter((ability) => isAttachmentAbility(ability) || /leading a unit|weapons equipped by models in that unit|models in that unit/i.test(ability.description))
    .map((ability) => clean(`${ability.name} ${ability.description}`));
  for (const text of texts) {
    bonuses.toughness += characteristicBonus(text, 'toughness');
    bonuses.wounds += characteristicBonus(text, 'wounds');
    bonuses.save += characteristicBonus(text, 'save');
    bonuses.invuln += characteristicBonus(text, 'invulnerable save');
    bonuses.leadership += characteristicBonus(text, 'leadership');
    bonuses.objectiveControl += characteristicBonus(text, 'objective control');
    bonuses.weaponAttacks += characteristicBonus(text, 'attacks');
    bonuses.weaponSkill += Math.max(
      characteristicBonus(text, 'ballistic skill'),
      characteristicBonus(text, 'weapon skill')
    );
    bonuses.weaponStrength += characteristicBonus(text, 'strength');
    bonuses.weaponDamage += characteristicBonus(text, 'damage');
    bonuses.weaponKeywords.push(...weaponKeywordsOf(text));
    bonuses.rerollHitOn.push(...rerollValues(text, 'hit'));
    bonuses.rerollWoundOn.push(...rerollValues(text, 'wound'));
    bonuses.rerollSaveOn.push(...rerollValues(text, 'save'));
  }
  return { ...bonuses, weaponKeywords: unique(bonuses.weaponKeywords), rerollHitOn: unique(bonuses.rerollHitOn), rerollWoundOn: unique(bonuses.rerollWoundOn), rerollSaveOn: unique(bonuses.rerollSaveOn) };
}

function applyWeaponBonuses(
  weapon: import('../combat/types.ts').CombatWeapon,
  bonuses: LeaderBonuses
): import('../combat/types.ts').CombatWeapon {
  const extra = parseKeywords(bonuses.weaponKeywords);
  const existing = new Set(weapon.keywords.map((keyword) => keyword.name));
  const keywords: ParsedKeyword[] = [...weapon.keywords, ...extra.filter((keyword) => !existing.has(keyword.name))];
  return {
    ...weapon,
    attacks: weapon.attacks === null ? null : { ...weapon.attacks, count: Math.max(0, weapon.attacks.count + bonuses.weaponAttacks) },
    skill: weapon.skill === null ? null : Math.max(2, weapon.skill - bonuses.weaponSkill),
    strength: weapon.strength === null ? null : weapon.strength + bonuses.weaponStrength,
    damage: weapon.damage === null ? null : { ...weapon.damage, plus: weapon.damage.plus + bonuses.weaponDamage },
    keywords,
  };
}

/** Возвращает глубокую копию отряда с применёнными бонусами лидера. */
export function applyLeaderBonuses(unit: CombatUnit, leader: LeaderDefinition): CombatUnit {
  const bonuses = leader.bonuses;
  return {
    ...unit,
    models: unit.models.map((model) => ({
      ...model,
      toughness: Math.max(1, model.toughness + bonuses.toughness),
      wounds: Math.max(1, model.wounds + bonuses.wounds),
      save: model.save === null ? null : Math.max(2, model.save - bonuses.save),
      invuln: model.invuln === null ? null : Math.max(2, model.invuln - bonuses.invuln),
      weapons: model.weapons.map((weapon) => applyWeaponBonuses(weapon, bonuses)),
    })),
  };
}

/** Объединяет отряд и присоединённого лидера в один боевой отряд. */
export function attachLeaderToUnit(unit: CombatUnit, leader: LeaderDefinition): CombatUnit {
  const bodyguard = applyLeaderBonuses(unit, leader);
  return {
    ...bodyguard,
    id: `${unit.id}+${leader.id}`,
    name: `${unit.name} + ${leader.name}`,
    models: [...bodyguard.models, ...leader.unit.models],
  };
}

/** Опции симуляции для reroll-бонусов лидера. */
export function leaderCombatOptionsOf(leader: LeaderDefinition): {
  rerollHitOn?: number[];
  rerollWoundOn?: number[];
  rerollSaveOn?: number[];
} {
  return {
    ...(leader.bonuses.rerollHitOn.length > 0 ? { rerollHitOn: leader.bonuses.rerollHitOn } : {}),
    ...(leader.bonuses.rerollWoundOn.length > 0 ? { rerollWoundOn: leader.bonuses.rerollWoundOn } : {}),
    ...(leader.bonuses.rerollSaveOn.length > 0 ? { rerollSaveOn: leader.bonuses.rerollSaveOn } : {}),
  };
}


