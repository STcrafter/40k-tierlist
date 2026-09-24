/**
 * Разбор профилей BattleScribe: характеристики лежат в `$text`, а сами профили
 * могут быть как встроены в узел, так и подключены ссылками (`infoLinks`).
 */

import { asArray, type BsDatabase } from './load.ts';
import type { BsProfileRaw, BsRuleRaw, BsSelectionNodeRaw } from './raw/types.ts';
import type { BsAbility, BsModelProfile, BsWeaponKind, BsWeaponProfile } from './types.ts';

/** Значение характеристики по имени ('M', 'Range'…); пустое → null. */
export function charValue(profile: BsProfileRaw, name: string): string | null {
  const found = asArray(profile.characteristics).find((c) => c.name === name);
  if (!found) return null;
  const raw = found.$text ?? found.value ?? '';
  const text = String(raw).trim();
  return text === '' ? null : text;
}

/** Профиль состоит из встроенных профилей и профилей по infoLinks. */
export function allProfiles(node: BsSelectionNodeRaw, db: BsDatabase): BsProfileRaw[] {
  const profiles = [...asArray(node.profiles)];
  for (const link of asArray(node.infoLinks)) {
    if (link.type !== 'profile') continue;
    const target = db.definition(link.targetId);
    if (target && 'characteristics' in target) profiles.push(target as BsProfileRaw);
  }
  return profiles;
}

/** Общие правила: встроенные `rules` + правила по infoLinks. */
export function allRules(node: BsSelectionNodeRaw, db: BsDatabase): BsAbility[] {
  const abilities: BsAbility[] = [];
  for (const rule of asArray(node.rules)) {
    abilities.push({
      name: String(rule.name ?? ''),
      description: String(rule.description ?? '').trim(),
      kind: 'datasheet',
    });
  }
  for (const link of asArray(node.infoLinks)) {
    if (link.type !== 'rule') continue;
    const target = db.definition(link.targetId) as BsRuleRaw | null;
    if (!target) continue;
    abilities.push({
      name: String(target.name ?? link.name ?? ''),
      description: String(target.description ?? '').trim(),
      kind: 'rule',
    });
  }
  return abilities;
}

/** Способности: профили типа Abilities → {имя, описание}. */
export function allAbilities(node: BsSelectionNodeRaw, db: BsDatabase): BsAbility[] {
  const abilities: BsAbility[] = [];
  for (const profile of allProfiles(node, db)) {
    if (profile.typeId !== db.meta.profileTypeIds.abilities) continue;
    abilities.push({
      name: String(profile.name ?? ''),
      description: charValue(profile, 'Description') ?? charValue(profile, 'Descriptions') ?? '',
      kind: 'datasheet',
    });
  }
  return abilities;
}

/** Описание способности, привязанной к узлу (профиль типа Abilities), иначе null. */
export function abilityProfileOf(node: BsSelectionNodeRaw, db: BsDatabase): string | null {
  const profile = allProfiles(node, db).find(
    (candidate) => candidate.typeId === db.meta.profileTypeIds.abilities
  );
  if (!profile) return null;
  const text = charValue(profile, 'Description') ?? charValue(profile, 'Descriptions') ?? '';
  return text === '' ? null : text;
}

/** Профиль модели (тип Unit). Возвращает null, если профиля такого типа нет. */
export function modelProfileOf(node: BsSelectionNodeRaw, db: BsDatabase): BsModelProfile | null {
  const profile = allProfiles(node, db).find(
    (candidate) => candidate.typeId === db.meta.profileTypeIds.unit
  );
  if (!profile) return null;
  return {
    name: String(profile.name ?? ''),
    movement: charValue(profile, 'M'),
    toughness: charValue(profile, 'T'),
    save: charValue(profile, 'Sv'),
    wounds: charValue(profile, 'W'),
    leadership: charValue(profile, 'LD'),
    objectiveControl: charValue(profile, 'OC'),
    invulnerableSave: charValue(profile, 'InSv'),
  };
}

/** Оружейные профили (Ranged Weapons / Melee Weapons) с ключевыми словами. */
export function weaponProfilesOf(node: BsSelectionNodeRaw, db: BsDatabase): BsWeaponProfile[] {
  const { ranged, melee } = db.meta.profileTypeIds;
  const weapons: BsWeaponProfile[] = [];

  for (const profile of allProfiles(node, db)) {
    const kind: BsWeaponKind | null =
      profile.typeId === ranged ? 'ranged' : profile.typeId === melee ? 'melee' : null;
    if (kind === null) continue;

    const keywords = (charValue(profile, 'Keywords') ?? '')
      .split(',')
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword !== '');

    weapons.push({
      name: String(profile.name ?? ''),
      kind,
      range: charValue(profile, 'Range'),
      attacks: charValue(profile, 'A'),
      skill: charValue(profile, kind === 'ranged' ? 'BS' : 'WS'),
      strength: charValue(profile, 'S'),
      ap: charValue(profile, 'AP'),
      damage: charValue(profile, 'D'),
      keywords,
    });
  }

  return weapons;
}

/** Грузоподъёмность транспорта (профиль типа Transport). */
export function transportCapacityOf(node: BsSelectionNodeRaw, db: BsDatabase): string | null {
  const profile = allProfiles(node, db).find(
    (candidate) => candidate.typeId === db.meta.profileTypeIds.transport
  );
  return profile ? charValue(profile, 'Capacity') : null;
}