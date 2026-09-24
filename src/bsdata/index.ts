/**
 * Точка входа BSData-парсера: сырые BattleScribe JSON → даташиты с формулой
 * комплектации, профилями, способностями и ценами.
 *
 * Быстрый старт (Node/скрипты):
 *   import { bsFilesFromDir } from './bsdata/node-source.ts';
 *   import { loadBsData, parseBsDatabase } from './bsdata/index.ts';
 *
 *   const { datasheets, report } = parseBsDatabase(
 *     loadBsData(bsFilesFromDir('public/BSData/wh40k-11e'))
 *   );
 */

export { loadBsData, asArray, indexNode } from './load.ts';
export type { BsDatabase, BsDefinition, BsFileInput, BsMeta } from './load.ts';

export { parseBsDatabase, describeDatasheet, factionFromCatalogueName } from './units.ts';
export type { BsParseOptions, BsParseResult } from './units.ts';

export { buildDatasheet, categoriesOf, knownIdsOf } from './datasheets.ts';
export type { DatasheetBuildResult } from './datasheets.ts';

export {
  modelGroupsOf,
  choiceGroupsOf,
  wargearOf,
  weaponsOf,
  wargearAbilitiesOf,
  withoutRoster,
  asChoiceGroup,
} from './composition.ts';

export {
  allAbilities,
  allProfiles,
  allRules,
  abilityProfileOf,
  charValue,
  modelProfileOf,
  transportCapacityOf,
  weaponProfilesOf,
} from './profiles.ts';

export {
  costFormula,
  describeCondition,
  hasNonPtsCost,
  isRosterScoped,
  pointsCost,
  selectionLimits,
  unitWideLimit,
} from './constraints.ts';
export type { Limits } from './constraints.ts';

export {
  pointsFor,
  pointsForMinimumSize,
  sizeRangeOf,
  sizeTiersOf,
} from './points.ts';
export type { PointsResult, SizeRange, SizeTier } from './points.ts';

export { bsFilesFromDir, bsFilesFromUrls } from './node-source.ts';

export type {
  BsAbility,
  BsChoiceGroup,
  BsCostCondition,
  BsCostFormula,
  BsCostModifier,
  BsDatasheet,
  BsModelGroup,
  BsModelProfile,
  BsModelVariant,
  BsParseReport,
  BsWargear,
  BsWargearKind,
  BsWeaponKind,
  BsWeaponProfile,
} from './types.ts';

export type * from './raw/types.ts';