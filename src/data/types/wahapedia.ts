// src/data/types/wahapedia.ts

export interface WahapediaFaction {
  id: string;
  name: string;
  link: string;
}

export interface WahapediaSource {
  id: string;
  name: string;
  type: string;
  edition: string;
  version: string;
  errata_date: string;
  errata_link: string;
}

export interface WahapediaOption {
  datasheet_id: string;
  line: string;
  button: string;
  description: string;
}

export interface WahapediaComposition {
  datasheet_id: string;
  line: string;
  description: string;
}

export interface WahapediaDatasheet {
  id: string;
  name: string;
  faction_id: string;
  source_id: string;
  legend: string;
  role: string;
  loadout: string;
  transport: string;
  virtual: boolean;
  is_support: boolean;
  leader_head: string;
  leader_footer: string;
  damaged_w: string;
  damaged_description: string;
  link: string;
}

export interface WahapediaModel {
  datasheet_id: string;
  line: string;
  name: string;
  M: string;
  T: string;
  Sv: string;
  inv_sv: string;
  inv_sv_descr: string;
  W: string;
  Ld: string;
  OC: string;
  base_size: string;
  base_size_descr: string;
}

export interface WahapediaWargear {
  datasheet_id: string;
  line: string;
  line_in_wargear: string;
  dice: string;
  name: string;
  description: string;
  range: string;
  type: string;
  A: string;
  BS_WS: string;
  S: string;
  AP: string;
  D: string;
}

export interface WahapediaAbility {
  datasheet_id: string;
  line: string;
  ability_id: string;
  model: string;
  name: string;
  description: string;
  type: string;
  parameter: string;
}

export interface WahapediaKeyword {
  datasheet_id: string;
  keyword: string;
  model: string;
  is_faction_keyword: boolean;
}

export interface WahapediaCost {
  datasheet_id: string;
  line: string;
  description: string;
  cost: string;
}

export interface WahapediaStratagem {
  id: string;
  faction_id: string;
  name: string;
  type: string;
  cp_cost: string;
  legend: string;
  turn: string;
  phase: string;
  description: string;
  detachment: string;
  detachment_id: string;
}

export interface WahapediaDetachment {
  id: string;
  faction_id: string;
  name: string;
  legend: string;
  type: string;
  dp: string;
  force_disposition: string;
}

export interface WahapediaData {
  options: WahapediaOption[];
  composition: WahapediaComposition[];
  factions: WahapediaFaction[];
  sources: WahapediaSource[];
  datasheets: WahapediaDatasheet[];
  models: WahapediaModel[];
  wargear: WahapediaWargear[];
  abilities: WahapediaAbility[];
  keywords: WahapediaKeyword[];
  costs: WahapediaCost[];
  stratagems: WahapediaStratagem[];
  detachments: WahapediaDetachment[];
}