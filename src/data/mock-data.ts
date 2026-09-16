// src/data/mock-data.ts

export const MOCK_FACTIONS = `id|name|link
SM|Space Marines|https://wahapedia.ru/space-marines
NEC|Necrons|https://wahapedia.ru/necrons`;

export const MOCK_SOURCES = `id|name|type|edition|version|errata_date|errata_link
SM-INDEX|Space Marines Index|Index|10th|1.0|2024-01-01|https://wahapedia.ru`;

export const MOCK_DATASHEETS = `id|name|faction_id|source_id|legend|role|loadout|transport|virtual|is_support|leader_head|leader_footer|damaged_w|damaged_description|link
sm-intercessors|Intercessor Squad|SM|SM-INDEX|Core infantry|BATTLELINE|Each model is armed with:|-|false|false|||0-5|Halved characteristics|https://wahapedia.ru/intercessors
sm-terminators|Terminator Squad|SM|SM-INDEX|Elite infantry|BATTLELINE|Each model is armed with:|-|false|false|||0-3|Halved characteristics|https://wahapedia.ru/terminators`;

export const MOCK_MODELS = `datasheet_id|line|name|M|T|Sv|inv_sv|inv_sv_descr|W|Ld|OC|base_size|base_size_descr
sm-intercessors|1|Intercessor|6"|4|3+|-|-|2|6+|1|25mm|Round
sm-terminators|1|Terminator|5"|5|2+|4+|Against attacks with Strength 3 or less|3|6+|1|40mm|Round`;

export const MOCK_WARGEAR = `datasheet_id|line|line_in_wargear|dice|name|description|range|type|A|BS_WS|S|AP|D
sm-intercessors|1|1||Bolt rifle|ASSAULT HEAVY SUSTAINED HITS 1|30"|Range|1|3+|4|-1|1
sm-intercessors|1|2||Bolt pistol|PISTOL|12"|Range|1|3+|4|0|1
sm-intercessors|1|3||Close combat weapon|MELEE|Melee|Melee|3|3+|4|0|1
sm-terminators|1|1||Power fist|-|Melee|Melee|2|3+|8|-2|2
sm-terminators|1|2||Storm bolter|ASSAULT|24"|Range|2|3+|4|0|1`;

export const MOCK_KEYWORDS = `datasheet_id|keyword|model|is_faction_keyword
sm-intercessors|INFANTRY||false
sm-intercessors|BATTLELINE||false
sm-intercessors|SQUAD||false
sm-intercessors|ADEPTUS ASTARTES||true
sm-terminators|INFANTRY||false
sm-terminators|TERMINATOR||false
sm-terminators|ADEPTUS ASTARTES||true`;

export const MOCK_COSTS = `datasheet_id|line|description|cost
sm-intercessors|1|5 models|80
sm-intercessors|2|10 models|160
sm-terminators|1|5 models|160
sm-terminators|2|10 models|320`;

export const MOCK_STRATAGEMS = `id|faction_id|name|type|cp_cost|legend|turn|phase|description|detachment|detachment_id
sm-tactical-precision|SM|Tactical Precision|Strategic Ploy|1|Use when unit shoots|-|Shooting|Reroll hits|Gladius Taskforce|sm-gladius`;

export const MOCK_DETACHMENTS = `id|faction_id|name|legend|type|dp|force_disposition
sm-gladius|SM|Gladius Taskforce|Aggressive|Detachment|0|Take and Hold`;

export const MOCK_DATA: Record<string, string> = {
  'Factions.csv': MOCK_FACTIONS,
  'Source.csv': MOCK_SOURCES,
  'Datasheets.csv': MOCK_DATASHEETS,
  'Datasheets_models.csv': MOCK_MODELS,
  'Datasheets_wargear.csv': MOCK_WARGEAR,
  'Datasheets_abilities.csv': '',
  'Datasheets_keywords.csv': MOCK_KEYWORDS,
  'Datasheets_models_cost.csv': MOCK_COSTS,
  'Stratagems.csv': MOCK_STRATAGEMS,
  'Detachments.csv': MOCK_DETACHMENTS,
};