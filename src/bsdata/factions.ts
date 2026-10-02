/**
 * Канонические фракции: единственное место, где решается, во что превращается
 * значение `Faction: …` из BSData.
 *
 * ЗАЧЕМ ДВА ПОЛЯ. В базе фракция выглядит плоско, но в игре у большинства
 * фракций есть подразделения, которые выставляются как отдельная армия:
 * 12 чаптеров Adeptus Astartes, легионы Chaos Daemons, Ynnari и Harlequins
 * внутри эльдари. Если вывалить всё в один список, в подборке фракций получается
 * 47 пунктов, из которых двенадцать — это Blood Angels.
 *
 * Поэтому у юнита две величины:
 *  - `faction` — верхняя фракция, то, что стоит в выпадающем списке;
 *  - `subFaction` — конкретное подразделение внутри неё.
 *
 * Подразделение НЕ влияет на то, какие лидеры к юниту присоединяются: лидер
 * ведёт отряд своей фракции, а чаптер — это стиль ростера. Именно поэтому
 * Black Templars перестали быть отдельной фракцией: `Sternguard Veteran Squad`
 * помечался фракцией `Black Templars`, и ни один астартес-лидер до него не
 * доходил — 15 пар, разрешённых правилами, просто не существовало.
 *
 * Друкари остаётся ОТДЕЛЬНОЙ фракцией: по решению владельца проекта Аeldari и
 * Drukhari — разные фракции, несмотря на общее происхождение.
 *
 * Ничего не разбирается из текста: правило переименования одно и явное, а
 * молча пропущенное значение из BSData обнаружилось бы только как лишний пункт
 * в фильтре. Тест сверяет каждую фракцию в сборке с этим файлом.
 */

/** Гиперфракции, у которых есть переключатель подфракций. */
export const ASTARTES_FACTION = 'Adeptus Astartes';
export const AELDARI_FACTION = 'Aeldari';
export const DAEMONS_FACTION = 'Legiones Daemonica';

export const DRUKHARI_FACTION = 'Drukhari';
export const CHAOS_SPACE_MARINES = 'Chaos Space Marines';

/** Список, по которому интерфейс решает, показывать ли переключатель подфракций. */
export const HYPERFACTIONS: readonly string[] = [
  ASTARTES_FACTION,
  AELDARI_FACTION,
  DAEMONS_FACTION,
];

/** Чаптеры, для которых BSData использует общие Astartes-даташиты. */
export const ASTARTES_CHAPTERS = [
  'Black Templars', 'Blood Angels', 'Dark Angels', 'Deathwatch', "Emperor's Children",
  'Imperial Fists', 'Iron Hands', 'Raven Guard', 'Salamanders', 'Space Wolves',
  'Ultramarines', 'White Scars',
] as const;

export const ASTARTES_CHAPTER_SET: ReadonlySet<string> = new Set(ASTARTES_CHAPTERS);

/**
 * Легионы Chaos Daemons. В BSData они названы не по богам, а по названиям
 * легионов предателей, хотя это те же четыре ротации.
 */
export const DAEMON_LEGIONS = [
  'Blood Legions', 'Plague Legions', 'Scintillating Legions', 'Legions of Excess',
] as const;

export const DAEMON_LEGION_SET: ReadonlySet<string> = new Set(DAEMON_LEGIONS);

/** Подразделения внутри Aeldari. Drukhari сюда НЕ входит — это отдельная фракция. */
export const AELDARI_SUBFACTIONS: readonly string[] = ['Ynnari', 'Harlequins'];

/** Куда превращается «Asuryani»: базовый юнит эльдари, без подразделения. */
const AELDARI_BASE = 'Asuryani';

export interface FactionRef {
  /** Верхняя фракция: попадает в список фильтра и в поле faction. */
  faction: string;
  /** Подразделение внутри гиперфракции; null у обычных юнитов. */
  subFaction: string | null;
}

/**
 * Имена каталогов, из которых фракция выводится, когда у юнита нет своего
 * `Faction:`. Это ЗАПАСНОЙ путь: он зависит от имён файлов, поэтому всё, что
 * он выдаёт, обязано попасть в ту же таблицу и не имеет права породить новую
 * фракцию. `Library` отбрасывается: два каталога называются «Chaos Knights
 * Library», и без этого в списке появлялось «Chaos Knights Library» вперемешку с
 * «Chaos Knights».
 */
const CATALOGUE_FACTION_ALIASES: Record<string, string> = {
  'Chaos Daemons': DAEMONS_FACTION,
  'Chaos Daemons Library': DAEMONS_FACTION,
  'Chaos Space Marines': CHAOS_SPACE_MARINES,
  'Aeldari': AELDARI_FACTION,
};

/**
 * Каноническое значение фракции по строке `Faction: …` из BSData.
 *
 * Значения, которых нет в таблице, проходят без изменений: так в список
 * попадает любая новая фракция из BSData, и тест на каноничность её увидит.
 */
export function canonicalFaction(raw: string): FactionRef {
  if (raw === 'Adeptus Astartes') return { faction: ASTARTES_FACTION, subFaction: null };
  if (ASTARTES_CHAPTER_SET.has(raw)) return { faction: ASTARTES_FACTION, subFaction: raw };

  if (raw === AELDARI_BASE) return { faction: AELDARI_FACTION, subFaction: null };
  if (AELDARI_SUBFACTIONS.includes(raw)) return { faction: AELDARI_FACTION, subFaction: raw };
  if (raw === DRUKHARI_FACTION) return { faction: DRUKHARI_FACTION, subFaction: null };

  if (raw === DAEMONS_FACTION) return { faction: DAEMONS_FACTION, subFaction: null };
  if (DAEMON_LEGION_SET.has(raw)) return { faction: DAEMONS_FACTION, subFaction: raw };

  // Само название BSData для Хаос Спейс Маринов. Переименовано, потому что
  // «Heretic Astartes» — это ещё и подразделение CSM, и в фильтре читалось бы
  // как отдельная фракция рядом с настоящими астартесами.
  if (raw === 'Heretic Astartes') return { faction: CHAOS_SPACE_MARINES, subFaction: null };

  return { faction: raw, subFaction: null };
}

/**
 * Имя каталога → фракция.
 *
 * Это тот самый запасной путь для юнитов без собственного `Faction:`. Здесь же
 * отбрасывается хвост `Library` — иначе «Chaos Knights Library» стал бы
 * отдельной фракцией рядом с «Chaos Knights», а разбор по `' - '` оставил бы
 * мусор на каталогах, названных без разделителя.
 */
export function factionFromCatalogue(name: string): FactionRef {
  const trimmed = name.trim();
  const alias = CATALOGUE_FACTION_ALIASES[trimmed];
  if (alias !== undefined) return { faction: alias, subFaction: null };

  const parts = trimmed
    .split(' - ')
    .map((part) => part.trim())
    .filter((part) => part !== '' && !/^library$/i.test(part));
  const last = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  if (last === undefined || last === '') return { faction: 'Unknown', subFaction: null };

  // «Chaos Knights Library» и прочие хвосты с Library: имя целиком не нашлось в
  // алиасах (например, каталог переименовали), поэтому Library снимаем здесь.
  const withoutLibrary = last.replace(/\s+Library$/i, '').trim();
  const resolved = CATALOGUE_FACTION_ALIASES[withoutLibrary];
  if (resolved !== undefined) return { faction: resolved, subFaction: null };
  return canonicalFaction(withoutLibrary === '' ? last : withoutLibrary);
}

/** Подразделение ли верхней фракции (для проверок в тестах). */
export function isHyperfaction(faction: string): boolean {
  return HYPERFACTIONS.includes(faction);
}