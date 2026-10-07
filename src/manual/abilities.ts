/**
 * РУЧНОЙ СЛОЙ СПОСОБНОСТЕЙ: то, что невозможно вывести из профилей и кейвордов.
 *
 * Зачем отдельный слой, а не частные случаи в адаптере и UI:
 *  - BSData хранит такие эффекты ПРОЗОМ в ability («…regains a wound…»,
 *    «can be resurrected…»), а боевой движок оперирует числами: раны, мортиды,
 *    кейворды. Сопоставление прозы с движком ломается на каждом новом юните;
 *  - частичные случаи в `adapter.ts` размазывались бы по коду, а в `utility.ts`
 *    — по UI: одно и то же правило пришлось бы искать в двух местах;
 *  - здесь правило записано ОДИН раз, типизировано и проверяется тестом.
 *
 * Чего слой НЕ делает принципиально: он не подменяет разбор общих правил
 * (FNP, Stealth, Anti-X) — они выводятся из данных и покрыты тестами. Здесь
 * только то, что из данных не извлекается в принципе.
 *
 * Ключи — id даташитов BSData (не имена): имена в базе меняются, id нет.
 */

import { parseKeywords } from '../combat/keywords.ts';
import type { CombatModel, CombatUnit, CombatWeapon, MortalDiceEffect } from '../combat/types.ts';

/** Идентификаторы utility-флагов, которые добавляются только вручную. */
export const MANUAL_UTILITY_FLAG_IDS = [
  'Sororitas_Devastating_Aura',
  'Sororitas_Anti_Warp',
  'Saint_Celestine_Blessing',
  'Triumph_Relic_Blessing',
  'Sororitas_Stealth_Aura',
  'Sororitas_Extra_Attacks',
  'Sororitas_Canoness_Aura',
  'Sororitas_Canoness_Jump_Aura',
  'Sororitas_Dialogus',
  'Sororitas_Dogmata',
  'Sororitas_Imagifier',
  'Sororitas_Battle_Sisters',
  'Sororitas_Immolator',
  'Sororitas_Celestian_Insidiants',
  'Sororitas_Dominion',
  'Sororitas_Retributors',
  'Sororitas_Sanctifiers',
  'Sororitas_Seraphim',
  'Sororitas_Novitiates',
  'Sororitas_Castigator',
  'Sororitas_Exorcist',
  'Sororitas_Penitent_Engines',
  'Custodes_Blade_Champion',
  'Custodes_Knight_Centura',
  'Custodes_Aleya',
  'Custodes_Shield_Captain',
  'Custodes_Shield_Captain_Allarus',
  'Custodes_Shield_Captain_Dawneagle',
  'Custodes_Allarus',
  'Custodes_Aquilon',
  'Custodes_Prosecutors',
  'Custodes_Vigilators',
  'Custodes_Witchseekers',
  'Custodes_Sagittarum',
  'Custodes_Venatari',
  'Custodes_Agamatus',
  'Custodes_Vertus_Praetors',
  'Orks_Boss_Snikrot',
  'Orks_Ghazghkull_Thraka',
  'Orks_Mozrog_Skragbad',
  'Orks_Nazdreg',
  'Orks_Wazdakka_Gutsmek',
] as const;

export type ManualUtilityFlagId = (typeof MANUAL_UTILITY_FLAG_IDS)[number];

/**
 * Ручной флаг стратегической полезности.
 *
 * Баллов здесь НЕТ намеренно. Раньше у каждого флага было своё поле `points`,
 * но в скор оно не попадало: `detectUtilityFlags` берёт цену из
 * `UTILITY_POINTS` (src/tier/utility.ts). Два источника правды расходились бы
 * молча — при полном совпадении чисел расхождение заметно только по сдвигу
 * тиров через месяц. Теперь единственный источник — `UTILITY_POINTS`, а тест
 * целостности слоя проверяет, что каждый ручной id там есть и что цена
 * положительна.
 */
export interface ManualUtilityFlag {
  id: ManualUtilityFlagId;
  /** Почему флаг выставлен — попадает в отчёт, чтобы список читался глазами. */
  reason: string;
}

/** Дополнительные мортиды от способности, действующие только в своей фазе. */
export interface MortalDamageBonus {
  amount: number;
  phase: 'ranged' | 'melee';
}

/**
 * Делитель для ОДНОРАЗОВЫХ эффектов.
 *
 * Способности вида «once per battle: +3 attacks» не действуют постоянно, но и
 * не дают нулевого эффекта. По решению владельца проекта такое считается как
 * «1 раунд из 3»: +3 атаки дают +1 атаку, +3 силы — +1 силу. Это заметно
 * консервативнее, чем считать эффект постоянным, и не обнуляет способность.
 */
export const ONCE_DIVISOR = 3;

/**
 * Аура лидера: эффекты, которые действуют И на самого лидера, И на
 * присоединённый к нему юнит.
 *
 * Отдельное поле, а не `LeaderBonuses`, потому что обычные бонусы лидера
 * выводятся разбором текста, а здесь эффекты заданы руками.
 */
export interface LeaderAura {
  /** Лидер и юнит получают STEALTH (Junith Eruita). */
  stealth?: boolean;
  /**
   * Кейворды оружию ПРИСОЕДИНЁННОГО юнита (Morvenn: Abbess Sanctorum).
   *
   * Отдельное поле от `weaponKeywords`, потому что то достаётся и самому
   * лидеру: LANCE нужен её собственному копью, а переброс попаданий и ранений
   * в правилах достаётся «each time a model in that unit makes an attack» — то
   * есть только отряду. Смешав их в одно поле, мы бы либо усилили героиню, либо
   * сняли бонус с отряда.
   *
   * Перебросы выражены кейвордами ('Reroll hits', 'Reroll wounds'), а не
   * списками `rerollHitOn`/`rerollWoundOn`: списки умеют только «перебросить
   * единицы» и не умеют условие по типу цели. Раньше в ауре были именно такие
   * поля, и они не читались НИГДЕ — способность молча ничего не давала.
   */
  unitWeaponKeywords?: string[];
  /**
   * Лидер даёт присоединённому отряду защиту (FNP / ward).
   *
   * Единственное поле в ауре, которое НИЧЕГО не меняет в бою: это метка для
   * utility-флага `Aura_Ward`. Так сделано намеренно — см. `detectLeaderAuraFlags`.
   * Одно поле вместо разбора текста: способности лидеров переписываются раз в
   * сезон, и молча пропавший флаг обнаружился бы только по сдвигу тиров через
   * месяц. Здесь же лишний id падает в тесте сразу и с точным именем лидера.
   */
  wardAura?: boolean;
  /** Feel No Pain лидеру и юниту (Hospitaller). */
  fnp?: number;
  /** Сейв приводится к этому значению: 2 = save 2+ (Imagifier). */
  saveAtLeast?: number;
  /** Инвульнити-сейв приводится к этому значению: 4 = 4+ (Imagifier). */
  invulnAtLeast?: number;
  /** +1 к попаданию лидера и юнита (Canoness, Junith). */
  toHit?: number;
  /** +N атак всему оружию лидера (Intranzia Fraye, Palatine). */
  extraAttacks?: number;
  /** Кейворды оружию лидера (Morvenn Vahl — LANCE). */
  weaponKeywords?: string[];
  /**
   * Ухудшение AP входящих рукопашных атак на N (Valerian: «Golden Laurels … у
   * каждой рукопашной атаки по отряду AP хуже на 1»).
   *
   * Именно защита, поэтому эффект живёт на моделях, а не на оружии. Раньше
   * здесь было `apDelta`, которое меняло AP СОБСТВЕННЫХ клинков: правило,
   * ухудшающее чужую атаку, отдавалось юниту как усиление его атаки.
   */
  meleeApWorsening?: number;
/**
 * Одноразовые эффекты оружию лидера: +N атак и +M силы в рукопашной.
 *
 * В бой они НЕ применяются: см. ONCE_DIVISOR. Значения хранятся здесь, чтобы
 * по ним отдельно считалась дельта (см. onceEffectDeltasOf), а не чтобы искажать
 * боевой расчёт.
 */
  onceMeleeAttacks?: number;
  onceMeleeStrength?: number;
  /** Кейворд оружию лидера, действующий разово: Devastating у Canoness с ранцом. */
  onceMeleeKeywords?: string[];
}

export interface ManualAbility {
  /** +N мортид, но только в указанной фазе. */
  mortalDamageBonus?: MortalDamageBonus;
  /**
   * Feel No Pain юниту (Arco-Flagellants, Penitent Engines).
   *
   * В BSData у этих отрядов FNP нет — он идёт от способности, поэтому здесь
   * и задаётся вручную. `scope: 'mortals'` — защита только от мортидов.
   */
  fnp?: { value: number; scope?: 'all' | 'mortals' };
  /**
   * Ран, восстанавливаемых в начале каждого раунда (Sororitas Rhino: +1).
   */
  regeneration?: number;
  /** Перебрасывать неудачные броски попадания, указанные значения. */
  rerollHitOn?: number[];
  /** Перебрасывать неудачные броски ранений, указанные значения. */
  rerollWoundOn?: number[];
  /**
   * Ограничение reroll по виду атаки.
   *
   * null — на все атаки; иначе rerollHitOn/rerollWoundOn действуют только
   * в указанной фазе (Repentia — рукопашная, Retributor — стрельба).
   */
  rerollPhase?: 'ranged' | 'melee' | null;
  /**
   * Перезарядка оружия: +N атак всему оружию юнита (Arco-Flagellants: +2).
   */
  extraAttacks?: number;
  /**
   * Снижение сейва юнита до указанного значения (Mortifiers: save 3+).
   */
  saveAtLeast?: number;
  /**
   * Кейворды оружию, ограниченные рукопашной атакой (Zephyrim:
   * Sustained Hits 1 и «летальные» попадания в ближнем бою).
   */
  meleeWeaponKeywords?: string[];
  /**
   * +1 к попаданию и ранению против MONSTER/VEHICLE (Paragon Warsuits).
   *
   * Отдельное поле, а не [ANTI-X Y+]: тот кейворд даёт критическое ранение,
   * а здесь нужно просто улучшение на +1. Условие на цель проверяется в
   * rules.ts по кейвордам защитника.
   */
  antiBonus?: { hits: number; wounds: number };
  /**
   * Одноразовое воскрешение с полным запасом ран.
   *
   * null — такого правила нет. Список моделей обязателен: способность
   * воскрешения принадлежит конкретной модели, а не всему отряду, и у того же
   * юнита могут быть спутники (Geminae Superia у Saint Celestine), которые
   * воскрешению не подлежат.
   */
  resurrectOnceModels?: string[] | null;
  /** Стратегическая полезность, которой нет в общем разборе. */
  utilityFlags?: ManualUtilityFlag[];
  /** Аура: действует на лидера и на присоединённый юнит. */
  aura?: LeaderAura;
  /**
   * +1 мортида за каждое успешное ранение в рукопашной присоединённым юнитом
   * (Palatine). Считается по ранениям, а не по критическим, поэтому это
   * отдельное поле, а не mortalDamageBonus (тот работает только при
   * Devastating Wounds).
   */
  meleeMortalPerWound?: number;
  /**
   * Возврат 1 модели в присоединённый юнит каждый ход, пока лидер жив
   * (Hospitaller). Модель возвращается с полным запасом ран.
   */
  reviveModelPerRound?: number;
  /**
   * Способности, действующие только при присоединении ОПРЕДЕЛЁННОГО лидера.
   *
   * Отдельное поле, потому что такие правила двусторонние: юниту нужен именно
   * этот лидер, а не любой (Celestian Sacresants теряют 1 рану от ЛЮБОГО лидера,
   * а Sanctifiers получают свои бонусы только от Ministorum Priest).
   */
  withLeader?: LeaderConditional;
  /**
   * Одноразовый потолок инстансов урона за раунд (Shield-Captain in Allarus: 1).
   *
   * Одноразовый, поэтому в бой не идёт: применяется только в
   * `withOnceEffects`, откуда попадает в дельту одноразовых эффектов — в том
   * числе в дельту по выживаемости, где как раз и проявляется.
   */
  onceDamageCapPerRound?: number;
  /**
   * Одноразовый дополнительный залп дальнобойным оружием
   * (Custodian Guard: «shoots again with everything it has»).
   *
   * В замере — удвоение числа атак дальнобойного оружия: это ровно то, что даёт
   * второй залп в том же раунде.
   */
  onceExtraRangedVolley?: boolean;
  /**
   * Одноразовые кейворды дальнобойному оружию (Custodian Guard с Adrasite/
   * Pyrithite: «Once per battle … до конца фазы дальнобойное получает [LETHAL
   * HITS] и [IGNORES COVER]»).
   *
   * В бой не идёт — ровно как `onceMeleeKeywords`: одноразовый эффект живёт в
   * дельте, а не в постоянном уроне. Отдельное поле, а не расширение
   * `weaponKeywords`, потому что правило говорит именно о дальнобойном оружии.
   */
  onceRangedKeywords?: string[];
  /**
   * Одноразовый Feel No Pain (Custodian Wardens: «Living Fortress … до конца
   * фазы модели отряда получают FNP 4+»).
   *
   * Тоже только в дельте: постоянный FNP 4+ стоил бы примерно половины
   * живучести отряда, а способность работает один раз и до конца фазы.
   */
  onceFnp?: number;
  /**
   * Защитные кейворды на МОДЕЛИ отряда (Vigilators: −1 к попаданию рукопашной).
   *
   * Именно на модели, а не на оружии: удар получает юнит, а не его клинок.
   * Механика `MELEE_EVASION` уже читается движком (rules.ts).
   */
  modelKeywords?: string[];
  /**
   * Кейворды КОНКРЕТНЫМ оружию, по имени (Caladius: двум пушкам).
   *
   * Почему не «всему дальнобойному»: у Caladius три ствола, и способность
   * накрывает только два из них (Iliastus по не-технике, Arachnus по технике),
   * а Twin Lastrum bolt cannon остаётся без Lethal Hits. Правило «на всё
   * дальнобойное оружие» завысило бы юнита.
   *
   * `weapon` — часть имени оружия без учёта регистра. Это хрупко: переименование
   * в BSData оборвёт правило молча, поэтому ниже стоит тест, проверяющий, что
   * оружие с нужным именем вообще есть.
   */
  weaponKeywordsOn?: Array<{ weapon: string; keywords: string[] }>;
  /**
   * Оружие, которое за один ход применяет ВСЕ свои профили (Kustom Blasta X
   * у Nazdreg: Skorcha, Gatler и Shoota одновременно).
   *
   * Обычно из записи снаряжения берётся ровно один профиль на вид — «лучший»
   * (см. `selectWeaponProfiles` в адаптере), и остальные нигде не появляются.
   * Для этого оружия правило обратное: сделать можно выстрел каждым профилем,
   * то есть в отряде должно оказаться три дальнобойных ствола вместо одного.
   *
   * Каждая строка — часть имени записи снаряжения без учёта регистра, как и в
   * `weaponKeywordsOn`. Хрупко ровно так же: переименование в BSData оборвёт
   * правило молча, поэтому на это есть тест (см. abilities.test.ts).
   */
  allProfilesOn?: string[];
  /**
   * Кейворды ВСЕМУ оружию юнита, включая оба вида (Slayers of Tyrants).
   *
   * Отдельное поле от `meleeWeaponKeywords`, потому что способность говорит
   * «each time a model makes an attack» — без ограничения фазой: у Allarus
   * Custodians это копьё, метательный болт и баллиста. Правило «только
   * рукопашное» здесь означало бы либо потерю половины атак, либо выдуманную
   * способность.
   */
  weaponKeywordsAll?: string[];
  /**
   * Одноразовые Devastating Wounds всему оружию (Sagittarum).
   *
   * В бой не идёт: живёт в дельте одноразовых эффектов, как и остальные
   * `once*`. Devastating отвечает за разовый поток мортид, а не за урон, и
   * постоянным он стоил бы отряду заметно больше, чем даёт разовый бой.
   */
  onceDevastating?: boolean;
  /** Уменьшение получаемого урона моделью (Telemon: −1 Damage). */
  damageTakenPenalty?: number;
  /** Лечение при гибели отряда (Venerable Contemptor). */
  healOnDeath?: { chance: number; sides: number };
  /** Мортиды от бросков кубиков (Ares Gunship, Contemptor-Achillus). */
  mortalDice?: MortalDiceEffect;
}

/** Что юнит получает или теряет при присоединении лидера. */
export interface LeaderConditional {
  /**
   * id допустимых лидеров; null — подходит любой лидер.
   *
   * Министорум Прист встречается в трёх списках (Adepta Sororitas, Agents of
   * the Imperium, Astra Militarum) под разными id, поэтому здесь перечисляются
   * все три, а не один.
   */
  leaderIds: string[] | null;
  /** Кейворды рукопашному оружию отряда (Sanctifiers: Sustained Hits 1). */
  meleeWeaponKeywords?: string[];
  /**
   * +N атак, +N к WS и +N силы рукопашному оружию отряда (Zodgrod Wortsnagga:
   * «Scavenged Shivs получают +1 A, +1 WS и +1 S»).
   *
   * `skill` — это УЛУЧШЕНИЕ WS, а не прибавка к порогу: 5+ → 4+ при skill: 1.
   * Знак выбран по правилам движка (`applyWeaponBonuses` в leaders.ts делает
   * `skill − weaponSkill`), чтобы «+1 к WS» и «+1 к попаданию» нельзя было
   * перепутать местом.
   */
  meleeWeaponStats?: { attacks: number; skill: number; strength: number };
  /**
   * Кейворды на МОДЕЛИ отряда, а не на оружии (Custodian Wardens с героем:
   * RESOLUTE_WILL).
   *
   * Защитные правила живут в rules.ts и смотрят на кейворды защитника, поэтому
   * их нельзя выразить кейвордом оружия: удар получает юнит, а не его клинок.
   */
  defensiveKeywords?: string[];
  /**
   * Сколько моделей отряда лидер возвращает в бой за раунд, пока сам жив
   * (Sanctifiers + Ministorum Priest: D3). Ставится на модели ЛИДЕРА.
   */
  reviveCount?: number;
}

/**
 * Ручные способности по id даташита.
 *
 * ID сверены с `public/BSData/wh40k-11e/Imperium - Adepta Sororitas.json`:
 *   4b94-c22e-84f9-8d32  Aestred Thurga and Agathae Dolan
 *   8569-2390-d4db-30fd  Daemonifuge
 *   21f1-8ed6-52c6-54c7  Saint Celestine
 *   9f5f-d769-7900-c8a1  Triumph of Saint Katherine
 */
export const MANUAL_ABILITIES: Record<string, ManualAbility> = {
  // Devastating Wounds идёт ОТ способности, а не от оружия: у Thurga/Dolan в
  // BSData оружие (Blade of Vigil, Scribe's staff) этого кейворда не имеет.
  // Идёт через `aura`, потому что способность действует и на присоединённый юнит.
  '4b94-c22e-84f9-8d32': {
    aura: { weaponKeywords: ['Devastating Wounds'] },
    utilityFlags: [
      {
        id: 'Sororitas_Devastating_Aura',
        reason:
          'Devastating Wounds своему оружию и оружию присоединённого юнита: превращает часть крит. ранений в мортиды',
      },
    ],
  },

  // Daemonifuge: +1 мортида в стрельбе. Считается только в ranged-фазе, потому
  // что способность ограничена дальнобойным огнём.
  '8569-2390-d4db-30fd': {
    mortalDamageBonus: { amount: 1, phase: 'ranged' },
    utilityFlags: [
      {
        id: 'Sororitas_Anti_Warp',
        reason: 'огонь по демонам: +1 мортида от критических ранений в стрельбе',
      },
    ],
  },

  // Celestine: восстановление ран между раундами и одноразовое воскрешение.
  // ВоскрешатьСЯ может только святая: у Geminae Superia такого правила нет.
  '21f1-8ed6-52c6-54c7': {
    regeneration: 1,
    resurrectOnceModels: ['Saint Celestine'],
    utilityFlags: [
      {
        id: 'Saint_Celestine_Blessing',
        reason: 'регенерация ран и одноразовое воскрешение с полным запасом ран',
      },
    ],
  },

  // Triumph of Saint Katherine — большой стратегический флаг: способность
  // меняет игру сильнее, чем её собственный урон. Ауру защиты она тоже даёт,
  // поэтому wardAura живёт здесь, а не в общем списке ниже.
  '9f5f-d769-7900-c8a1': {
    aura: { wardAura: true },
    utilityFlags: [
      {
        id: 'Triumph_Relic_Blessing',
        reason:
          'реликвия Triumph: мощное усиление присоединённого юнита (18 ран и 18 атак режущих)',
      },
    ],
  },

  // --- Лидеры Adepta Sororitas ---------------------------------------------
  // ID сверены с выгрузкой: Junith 8f9a-…, Intranzia e59a-…, Morvenn 7188-…,
  // Canoness c338-…, Canoness с ранцем e80a-…, Dialogus 91b8-…, Dogmata 76b1-…,
  // Hospitaller 938e-…, Imagifier 3ad3-…, Ministorum Priest 599d-… (Sororitas),
  // Palatine fbeb-….

  // Junith Eruita: STEALTH себе и юниту, −1 к попаданию рукопашными по ним.
  // Само «−1 к попаданию по рукопашным» — защита цели, поэтому оно вынесено в
  // rules.ts как кейворд MELEE_EVASION, а не в бонус атакующего.
  '8f9a-8a8b-2539-547f': {
    aura: { stealth: true, toHit: 1 },
    utilityFlags: [
      {
        id: 'Sororitas_Stealth_Aura',
        reason: 'STEALTH и −1 к попаданию рукопашными себе и присоединённому юниту',
      },
    ],
  },

  // Intranzia Fraye: +1 атака всему оружию (у неё оно и рукопашное, и огневое).
  'e59a-2a90-e102-940f': {
    aura: { extraAttacks: 1 },
    utilityFlags: [
      {
        id: 'Sororitas_Extra_Attacks',
        reason: '+1 атака всему оружию (Fists of Bzuulth) себе и присоединённому юниту',
      },
    ],
  },

  /*
   * Morvenn Vahl: Abbess Sanctorum — переброс попаданий и ранений ВСЕМУ отряду,
   * плюс +3 атаки и LANCE на её собственном оружии. Флага нет: перебросы — это
   * боевая ценность, платить за неё в utility значило бы удвоить смоделированное.
   *
   * Перебросы уходят кейвордами, а не списками `rerollHitOn`/`rerollWoundOn`:
   * правило даёт полный переброс («you can re-roll the Hit roll and you can
   * re-roll the Wound roll»), который списком не выражается. Раньше в ауре
   * стояли именно списки, и `applyAuraToModels` их не читал — то есть поля были
   * объявлены, заполнены и молча ничего не делали.
   *
   * Кейворды достаются присоединённому отряду, а не ей самой: правило говорит
   * «each time a model in that unit makes an attack».
   */
  '7188-4d20-8216-c68a': {
    aura: {
      extraAttacks: 3,
      weaponKeywords: ['Lance'],
      unitWeaponKeywords: ['Reroll hits', 'Reroll wounds'],
    },
  },

  // Canoness: инвульнити 2+ на один ход (себе) и +1 к попаданию себе и юниту.
  'c338-14f9-4ee-f223': {
    aura: { toHit: 1 },
    utilityFlags: [
      {
        id: 'Sororitas_Canoness_Aura',
        reason: '+1 к попаданию рукопашными себе и присоединённому юниту',
      },
    ],
  },

  // Canoness с ранцем: разово +3 атаки и Devastating на рукопашное оружие.
  // Значения исходные, делит их withOnceEffects при расчёте дельты.
  'e80a-4a97-2c3b-710e': {
    aura: { onceMeleeAttacks: 3, onceMeleeKeywords: ['Devastating Wounds'] },
    utilityFlags: [
      {
        id: 'Sororitas_Canoness_Jump_Aura',
        reason: 'одноразовые +3 атаки и Devastating Wounds на рукопашное оружие модели',
      },
    ],
  },

  // Dialogus: только стратегическая ценность.
  '91b8-3ccb-de30-6e54': {
    utilityFlags: [
      {
        id: 'Sororitas_Dialogus',
        reason: 'проповедь: раздаёт отрядные бонусы и держит цель на себе',
      },
    ],
  },

  // Dogmata: только стратегическая ценность.
  '76b1-f4d1-b2f0-6949': {
    utilityFlags: [
      {
        id: 'Sororitas_Dogmata',
        reason: 'собор: аура на Command/shader и лечение в фазе командования',
      },
    ],
  },

  // ── Аура защиты присоединённого отряда ────────────────────────────────
  //
  // Отмечается флагом `wardAura` (см. LeaderAura): это ЧИСТО utility-метка, она
  // ничего не меняет в бою. Смысл в том, чтобы такие лидеры получали кредит за
  // реальную ценность, которой модель не выдаёт.
  //
  // Список отобран по базе BSData cc1830f: лидеры, у которых текст про
  // FNP/ward относится к присоединённому отряду. 25 лидеров, 105 пар.
  //
  // Перебросы сюда НЕ внесены сознательно: они уже учитываются в бою через
  // `leaderBonusesOf` → `leaderCombatOptionsOf` у тех лидеров, чей текст
  // разбирается. У остальных переброс в модели не работает — это дыра в
  // способностях, а не внебоевая ценность, и оплачивать её значило бы платить
  // за эффект, которого нет.
  //
  // Hospitaller тоже не здесь: его FNP-аура смоделирована полем `aura.fnp`.
  'e367-b2cb-d22a-b17c': { aura: { wardAura: true } }, // Acolyte Iconward
  '5412-1f01-b7cc-bf12': { aura: { wardAura: true } }, // Brotherhood Librarian
  '74ba-6762-ef01-32d6': { aura: { wardAura: true } }, // Champion of the Chapter [Crucible]
  'c026-b762-d0a6-5ef1': { aura: { wardAura: true } }, // Chaplain in Terminator Armour
  '3ef1-1647-cd7b-a40b': { aura: { wardAura: true } }, // Chief Librarian Tigurius
  '36df-8f40-8a6b-7d4c': { aura: { wardAura: true } }, // Contorted Epitome
  '5e66-6f0-a181-cc4d': { aura: { wardAura: true } }, // Ethereal
  '38c9-66a1-fe60-46af': { aura: { wardAura: true } }, // Ezekiel
  'd3a3-2d20-bd7e-6778': { aura: { wardAura: true } }, // Grimnyr
  '2ba9-e97a-909d-3ac5': { aura: { wardAura: true } }, // Hordeboss [Crucible]
  '6c9d-4ec3-69dd-90b2': { aura: { wardAura: true } }, // Iron Father Feirros
  'bb34-e371-33ee-397': { aura: { wardAura: true } }, // Kroot Flesh Shaper
  '78eb-9334-f5c0-6095': { aura: { wardAura: true } }, // Librarian
  '137c-2add-1a51-ee96': { aura: { wardAura: true } }, // Librarian in Phobos Armour
  '2468-24f5-ad9b-8388': { aura: { wardAura: true } }, // Librarian in Terminator Armour
  '0385-0e03-0eac-d91c': { aura: { wardAura: true } }, // Librarius Adept [Crucible]
  '51e8-dac1-561a-aaa9': { aura: { wardAura: true } }, // Locus
  '4ad0-e988-a513-9530': { aura: { wardAura: true } }, // Primaris Psyker
  'f80-be5-d17c-db23': { aura: { wardAura: true } }, // Sanguinary Priest
  '6424-ed86-9e15-3e14': { aura: { wardAura: true } }, // Tech-Priest Dominus
  '852a-ba39-e93f-6b62': { aura: { wardAura: true } }, // Technomancer
  'dd79-c2fe-59d6-d2': { aura: { wardAura: true } }, // The Visarch
  '6a69-8e75-49ae-408f': { aura: { wardAura: true } }, // Upstart Gretchin [Crucible]
  '54de-2004-bbc1-3ac6': { aura: { wardAura: true } }, // Warphead [Crucible]

  // Hospitaller: FNP 5+ себе и юниту + возврат 1 модели в юнит за ход, пока
  // жив. FNP — смоделированная величина, флаг за неё не платится.
  '938e-1c24-4e63-4cf3': {
    aura: { fnp: 5 },
    reviveModelPerRound: 1,
  },

  // Imagifier: save 2+ и invsv 4+ себе и юниту.
  '3ad3-558b-29f9-2e45': {
    aura: { saveAtLeast: 2, invulnAtLeast: 4 },
    utilityFlags: [
      {
        id: 'Sororitas_Imagifier',
        reason: 'save 2+ и invsv 4+ себе и присоединённому юниту',
      },
    ],
  },

  // Ministorum Priest (Adepta Sororitas): +1 к ранению в рукопашной себе и
  // юниту, разово +3 силы и +3 атаки на рукопашное. Значения ИСХОДНЫЕ: деление
  // на ONCE_DIVISOR делает withOnceEffects при расчёте дельты.
  '599d-1e2a-eb0e-430e': {
    aura: { onceMeleeAttacks: 3, onceMeleeStrength: 3 },
  },

  // Palatine: +1 атака всему оружию (Fists of Bzuulth) и +1 мортида за каждое
  // успешное ранение в рукопашной присоединённым юнитом.
  'fbeb-1caf-8f5c-ff8e': {
    aura: { extraAttacks: 1 },
    meleeMortalPerWound: 1,
  },

  // --- Основные отряды Adepta Sororitas ------------------------------------
  // ID сверены с выгрузкой: Battle Sisters f26d-…, Immolator 1001-…,
  // Sororitas Rhino 52c7-…, Arco-Flagellants ca59-…, Insidiants e286-…,
  // Sacresants f1af-…, Dominion d929-…, Repentia 7d63-…, Retributor c49d-…,
  // Sanctifiers eade-… (Sororitas; не путать с 4e74-… из Agents of Imperium),
  // Seraphim bee9-…, Novitiate 4269-…, Zephyrim 22f0-…, Castigator 820-…,
  // Exorcist 684e-…, Mortifiers 3c3f-…, Paragon Warsuits e75d-…,
  // Penitent Engines 327d-….

  'f26d-450d-1c55-caeb': {
    utilityFlags: [
      {
        id: 'Sororitas_Battle_Sisters',
        reason: 'универсальный боец с Condemnor у офицера: стрельба, рукопашная, спецоружие',
      },
    ],
  },

  '1001-80ff-c9a8-5d9b': {
    utilityFlags: [
      {
        id: 'Sororitas_Immolator',
        reason: 'иммолатор: автопопадание и игнорирование укрытия по всем врагам',
      },
    ],
  },

  // +1 рана в ход: регенерация уже смоделирована в upkeepBetweenRounds.
  '52c7-3f6b-cece-8101': { regeneration: 1 },

  // FNP 5+ идёт от способности: в BSData у Arco-Flagellants его нет.
  'ca59-3760-5efc-9846': {
    fnp: { value: 5 },
    extraAttacks: 2,
  },

  // FNP 4+ против мортальных ран в BSData уже разобран (fnpScope 'mortals');
  // здесь только переброс попаданий.
  'e286-849d-8f74-75e6': {
    rerollHitOn: [1],
    utilityFlags: [
      {
        id: 'Sororitas_Celestian_Insidiants',
        reason: 'FNP 4+ против мортид и переброс попаданий на 1',
      },
    ],
  },

  // Celestian Sacresants: в BSData у них УЖЕ W1 — то есть потеря 1 раны за
  // присоединённого лидера в данных отражена. Дополнительно её вычитать нельзя:
  // модель с 1 раной от штрафа погибла бы ещё при постановке, и юит в составе
  // с лидером просто перестал бы существовать. Поэтому здесь ничего не задано
  // намеренно — см. тест «Celestian Sacresants не убиваются штрафом».

  'd929-b22d-3040-9707': {
    utilityFlags: [
      {
        id: 'Sororitas_Dominion',
        reason: 'гвардия части с усиленным офицером и заголовком',
      },
    ],
  },

  /*
   * Repentia: Overseer of Redemption — «you can re-roll the Hit roll and you can
   * re-roll the Wound roll» при рукопашной атаке, пока в отряде есть Superior
   * (в минимальной сборке он есть, у варианта `min: 1`).
   *
   * Переброс ПОЛНЫЙ, поэтому списками `rerollHitOn`/`rerollWoundOn` не
   * выражается: список — это «перебросить N», а правило требует «перебросить
   * всё». Кейворды попадают только на рукопашное оружие, поэтому Bolt pistol у
   * Superior их не наследует.
   */
  '7d63-7b55-a632-6a10': {
    meleeWeaponKeywords: ['Reroll hits', 'Reroll wounds'],
  },

  // Reroll 1 на попадания и ранения ТОЛЬКО при стрельбе.
  'c49d-f150-4b3-c118': {
    rerollHitOn: [1],
    rerollWoundOn: [1],
    rerollPhase: 'ranged',
    utilityFlags: [
      {
        id: 'Sororitas_Retributors',
        reason: 'переброс 1 на попадания и ранения в стрельбе',
      },
    ],
  },

  // Sanctifiers: при святом Министоруме получают Sustained Hits 1 на рукопашное,
  // а сам Министорум возвращает D3 моделей отряда за ход, пока жив. Оба
  // эффекта двусторонние — работают только вместе (см. leaders.ts).
  'eade-6ec7-7236-bfdb': {
    withLeader: {
      leaderIds: ['599d-1e2a-eb0e-430e', '7554-37de-cd68-68a7', 'ba72-7b05-33c9-a1c0'],
      meleeWeaponKeywords: ['Sustained Hits 1'],
      reviveCount: 3,
    },
    utilityFlags: [
      {
        id: 'Sororitas_Sanctifiers',
        reason: 'Miraculist: Sustained Hits 1 и возврат D3 моделей при святом Министоруме',
      },
    ],
  },

  'bee9-172b-7db7-f748': {
    utilityFlags: [
      {
        id: 'Sororitas_Seraphim',
        reason: 'прыгающие и летающие с рукопашной в ближней и глухой стрельбой',
      },
    ],
  },

  '4269-a229-1461-67d0': {
    rerollHitOn: [1],
    utilityFlags: [
      {
        id: 'Sororitas_Novitiates',
        reason: 'дешёвые новницы с перебросом попадания на 1 и заголовком',
      },
    ],
  },

  // Zephyrim: Sustained Hits 1 + «летальные» попадания в рукопашной.
  '22f0-a7d8-b2b6-e26': {
    meleeWeaponKeywords: ['Sustained Hits 1', 'Lethal Hits: non-VEHICLE'],
  },

  '820-1e76-78cc-931a': {
    utilityFlags: [
      {
        id: 'Sororitas_Castigator',
        reason: 'тяжёлая техника с парой скорострельных автопушек',
      },
    ],
  },

  '684e-4dd3-340a-23ee': {
    utilityFlags: [
      {
        id: 'Sororitas_Exorcist',
        reason: 'космический боец с непрямым огнём реактивных установок',
      },
    ],
  },

  // Mortifiers: save 4+ из BSData ухудшается до 3+.
  '3c3f-f02d-c05c-492a': { saveAtLeast: 3 },

  // Paragon Warsuits: +1 к попаданию и ранению ПРОТИВ монстров и техники.
  // Условие на цель нельзя выразить обычным [ANTI-X Y+] — там оно даёт
  // критическое ранение, а тут просто +1. Поэтому это отдельный кейворд,
  // который обрабатывается в rules.ts.
  'e75d-a7ac-7fcc-d302': { antiBonus: { hits: 1, wounds: 1 } },

  // FNP 5+ идёт от способности: в BSData у Penitent Engines его нет.
  '327d-a6df-26b-bb9b': {
    fnp: { value: 5 },
    utilityFlags: [
      {
        id: 'Sororitas_Penitent_Engines',
        reason: 'автопопадание ближнего огня и FNP 5+ при низком Т',
      },
    ],
  },

  // ── Adeptus Custodes ───────────────────────────────────────────────────────
  // ID — из `public/BSData/wh40k-11e/Imperium - Adeptus Custodes.json`.

  /*
   * Aleya: Fights First отряду (Tactical Perception), FNP 3+ против психики и
   * мортид (Daughter of the Abyss), снятие «поломки» преследования
   * (Ceaseless Vigilance).
   *
   * Переброса попаданий у неё нет: раньше здесь стоял `rerollHitOn: [1]`, то
   * есть юнит получал в постоянный бой переброс, которого нет ни в одном её
   * правиле. Tenacious Spirit (+1 к попаданию и ранению, но только когда отряд
   * потрёпан) движок не моделирует: замер идёт по свежему отряду, состояния
   * «потрёпан» в контексте атаки просто нет — такую способность честнее
   * оставить ценой флага, чем подменять другим перебросом.
   */
  '9e42-7207-9c30-6122': {
    utilityFlags: [
      {
        id: 'Custodes_Aleya',
        reason: 'Fights First отряду и FNP 3+ против психики и мортид',
      },
    ],
  },

  /*
   * Allarus Custodians: Slayers of Tyrants — переброс ЛЮБОГО неудачного
   * броска ранения при атаке по CHARACTER/MONSTER/VEHICLE.
   *
   * Раньше здесь стояло `rerollWoundOn: [1]`, и это была двойная поломка:
   * перебрасывались только единицы (а правило даёт полный переброс) и работал
   * он по любой цели (а правило ограничено тремя типами). Теперь переброс —
   * кейворд с условием, который читает rules.ts по кейвордам защитника.
   *
   * Флаг в 1 балл остаётся: переброс смоделирован, а незакрытая половина
   * правила — Devastating Wounds по всем целям (условие на цель у мортид в
   * движке не выражено).
   */
  'c8a6-a4c5-703e-b717': {
    weaponKeywordsAll: ['Reroll wounds: CHARACTER/MONSTER/VEHICLE'],
    utilityFlags: [
      {
        id: 'Custodes_Allarus',
        reason: 'Devastating Wounds по всем целям: условие на тип цели в мортидах не выражено',
      },
    ],
  },

  // Aquilon Custodians: переброс ранения на 1 в стрельбе. Фаза обязательна,
  // иначе переброс ушёл бы и в рукопашную, где способности нет.
  '03bc-0141-b967-40e0': {
    rerollWoundOn: [1],
    rerollPhase: 'ranged',
    utilityFlags: [
      { id: 'Custodes_Aquilon', reason: 'переброс ранения на 1 в дальнем бою' },
    ],
  },

  // Blade Champion и Knight-Centura — EPIC HERO: каждый добавляет юниту целый
  // дополнительный раунд работы, поэтому самые дорогие флаги в наборе.
  '48b7-e713-d5b1-f11c': {
    utilityFlags: [
      {
        id: 'Custodes_Blade_Champion',
        reason: 'EPIC HERO с большим объёмом атак и ре-роллами',
      },
    ],
  },
  // Knight-Centura. ID сверен с базой: в прежней записи стояло `7099-71b2-…`
  // вместо `7099-71b-…`, и ни один даташит под таким ключом не находился —
  // запись молча не срабатывала, а вместе с ней и флаг на 3 балла.
  '7099-71b-56e8-7191': {
    utilityFlags: [
      {
        id: 'Custodes_Knight_Centura',
        reason:
          'EPIC HERO Anathema Psykana: FNP 3+ против психики и мортид, +2 к Move и к броскам Advance/Charge отряда',
      },
    ],
  },

  // Custodian Guard: переброс ранения на 1 и одноразовый повторный залп.
  '91b3-2e1c-e642-d213': { rerollWoundOn: [1], onceExtraRangedVolley: true },

  /*
   * Custodian Guard with Adrasite and Pyrithite Spears: Stand Vigil плюс No Foe
   * Shall Stand — «Once per battle … до конца фазы дальнобойное оружие получает
   * [LETHAL HITS] и [IGNORES COVER]».
   *
   * Способность одноразовая и только для стрельбы, поэтому она уходит в дельту
   * (`onceRangedKeywords`), а не в постоянные кейворды. Раньше Lethal Hits
   * висел на отряде насовсем и попадал на ВСЁ оружие, включая рукопашное, а
   * Ignores Cover не учитывался вовсе.
   */
  'af0f-5212-907e-7125': {
    rerollWoundOn: [1],
    onceRangedKeywords: ['Lethal Hits', 'Ignores Cover'],
  },

  /*
   * Custodian Wardens:
   *   Resolute Will — «пока CHARACTER ведёт отряд, у атаки с S выше T отряда
   *   минус 1 к броску ранения». Это ухудшение ЧУЖОГО броска, а не потеря ран
   *   у Стражей: раньше здесь стоял woundsPenalty, который отнимал 1 рану у
   *   каждой модели (W3 → W2, минус треть живучести), то есть способность,
   *   данная юниту, работала штрафом за него. Теперь это защитный кейворд на
   *   моделях, который читает rules.ts.
   *   Living Fortress — FNP 4+ один раз за бой до конца фазы, поэтому он ушёл
   *   в одноразовые эффекты (дельту). Постоянный FNP 4+ стоил бы примерно
   *   половины живучести отряда, а способность работает однократно.
   */
  '9610-b148-8433-93b8': {
    withLeader: { leaderIds: null, defensiveKeywords: ['RESOLUTE_WILL'] },
    onceFnp: 4,
  },

  /*
   * Shield-Captain: Master of the Stances включает ОБЕ стойки, то есть
   * рукопашное оружие получает [SUSTAINED HITS 1] (DACATARAI) и [LETHAL HITS]
   * (RENDAX). Раньше здесь стояло «Active» — такого кейворда нет ни в одном
   * правиле движка, поэтому RENDAX молча терялся, и в дельту попадало ровно то,
   * что отряд и так получает от DACATARAI.
   */
  'b61c-b815-65c0-b1cc': {
    aura: { onceMeleeKeywords: ['Sustained Hits 1', 'Lethal Hits'] },
    utilityFlags: [
      {
        id: 'Custodes_Shield_Captain',
        reason: 'одноразовые Active и Sustained Hits 1 в рукопашной',
      },
    ],
  },

  // Shield-Captain in Allarus Terminator Armour: одноразово весь получаемый
  // урон за раунд сводится к одному инстансу. Именно инстансы, а не раны:
  // это не FNP (тот невелирует урон) и не Invuln (тот про мортиды).
  '6319-eeba-b717-bd86': {
    onceDamageCapPerRound: 1,
    utilityFlags: [
      {
        id: 'Custodes_Shield_Captain_Allarus',
        reason: 'одноразовое ограничение урона до одного инстанса за раунд',
      },
    ],
  },

  // Shield-Captain on Dawneagle Jetbike: FLY на скоростном корпусе.
  '58fa-4a25-a5af-1144': {
    utilityFlags: [
      {
        id: 'Custodes_Shield_Captain_Dawneagle',
        reason: 'jetbike даёт FLY и быстрый ввод в бой',
      },
    ],
  },

  // Trajann Valoris: одноразово 12 атак топором вместо 6 — +6 к числу атак.
  '7d7c-c212-47a3-38e4': { aura: { onceMeleeAttacks: 6 } },

  /*
   * Valerian: Golden Laurels — «пока ведёт отряд, у каждой рукопашной атаки по
   * отряду AP хуже на 1». Это защита, а не усиление: раньше здесь стоял
   * apDelta, который менял AP СОБСТВЕННОГО оружия (Gnosis AP-3 → AP-4), то
   * есть незаработанный атакующий бафф вместо правила. Теперь эффект
   * защитный и лежит на моделях: рукопашный урон по отряду слабее.
   */
  '8103-2e01-5d6a-b761': { aura: { meleeApWorsening: 1 } },

  /*
   * ── Остальные кустодезы ───────────────────────────────────────────────────
   *
   * Часть списка уже была настроена выше (Allarus, Aquilon, Custodian Guard,
   * копья, Wardens) — здесь только то, чего в слое не было.
   *
   * Про «не имеют ката»: Martial Ka'tah выводится из `datasheet.rules`
   * функцией hasMartialKatah, поэтому отсутствие правила в данных уже означает
   * «стойки нет». Ручная запись для этого не нужна и была бы дублированием.
   */

  /*
   * Prosecutors: Devastating Wounds по персонажам (условие на цель в движке
   * для мортид не выражено — цена флагом) и FNP 3+ против псионики и мортид.
   *
   * Псионические атаки не моделируются, поэтому FNP получает область
   * 'mortals' — это ОГРАНИЧЕНИЕ области, а не усиление: обычный урон он не
   * невелирует. Недостающая половина правила оплачена флагом, по той же
   * причине, по которой Aleya получила флаг при FNP 3+ от способности.
   */
  '3ec3-a4df-fdbf-5507': {
    fnp: { value: 3, scope: 'mortals' },
    utilityFlags: [
      {
        id: 'Custodes_Prosecutors',
        reason: 'Purity of Execution (Devastating по персонажам) и Daughters of the Abyss: FNP 3+ против псионики и мортид',
      },
    ],
  },

  /*
   * Vigilators: −1 к попаданию РУКОПАШНОЙ атакой по отряду. Кейворд MELEE_EVASION
   * уже умеет движок (rules.ts), и он защитный — бьёт по чужому броску.
   * Такой же, как у Junith Eruita, только здесь без ауры.
   */
  'dd2d-568a-9c56-1b6e': {
    modelKeywords: ['MELEE_EVASION'],
    fnp: { value: 3, scope: 'mortals' },
    utilityFlags: [
      {
        id: 'Custodes_Vigilators',
        reason: 'Deft Parry: −1 к попаданию рукопашной по себе, и Daughters of the Abyss: FNP 3+ против псионики и мортид',
      },
    ],
  },

  // Witchseekers: то же FNP 3+ против псионики и мортид, что у двух выше.
  '503b-f7be-eeeb-9e31': {
    fnp: { value: 3, scope: 'mortals' },
    utilityFlags: [
      {
        id: 'Custodes_Witchseekers',
        reason: 'Daughters of the Abyss: FNP 3+ против псионики и мортид, плюс Sanctified Flames',
      },
    ],
  },

  /*
   * Sagittarum: одноразовые Devastating Wounds. Уходит в дельту одноразовых
   * эффектов (`onceDevastating`), а не в постоянные кейворды: разовый поток
   * мортид не должен постоянно улучшать юнита во всех режимах.
   */
  '6f9f-e6aa-ba13-aab1': {
    onceDevastating: true,
    utilityFlags: [
      {
        id: 'Custodes_Sagittarum',
        reason: 'одноразовые Devastating Wounds (Saturation Volleys) в ближнем бою',
      },
    ],
  },

  '201e-e502-a8d1-3974': {
    utilityFlags: [
      {
        id: 'Custodes_Venatari',
        reason: 'Strike from the Skies и Swooping Dive: вход в бой с воздуха и пикирование с усиленным уроном',
      },
    ],
  },

  '00ab-41c4-cf52-4ad2': {
    utilityFlags: [
      {
        id: 'Custodes_Agamatus',
        reason: 'Implacable Vanguard (Deep Strike) и Turbo Boost: ввод в бой с воздуха и усиленный рывок',
      },
    ],
  },

  '918b-c9ed-7af7-74df': {
    utilityFlags: [
      {
        id: 'Custodes_Vertus_Praetors',
        reason: 'аэроциклы с Turbo Boost и Quicksilver Execution',
      },
    ],
  },

  /*
   * Caladius: каждая атака Twin Iliastus (по не-технике) и Twin Arachnus
   * (по технике и монстрам) получает [LETHAL HITS]. Обе ветки дают одно и то же,
   * поэтому в замере это просто Lethal Hits на обеих пушках — условие на тип
   * цели различать нечего. В BSData кейворда на оружии нет, «Armoured hull»
   * (не оружие, а корпус) его тоже не получает.
   */
  '3ee2-62a9-af84-1a90': {
    weaponKeywordsOn: [
      { weapon: 'iliastus', keywords: ['Lethal Hits'] },
      { weapon: 'arachnus', keywords: ['Lethal Hits'] },
    ],
  },

  /*
   * Contemptor-Galatus — Galatus Shield: «Each time a melee attack targets this
   * model subtract 1 from the Wound roll».
   *
   * Раньше записи не было, и это была ошибка чтения: «−1 на ту вунд» — это
   * минус к броску РАНЕНИЯ, а не улучшение сейва. Сейв и бросок ранения — разные
   * вещи: +1 к сейву не мешает врагу ранить, −1 к ранению мешает.
   *
   * Штраф идёт к самому броску (rules.woundRollPenalty), а не к порогу:
   * порог зажимается единицей, и «+1 к порогу» на T9 не изменил бы ничего —
   * почти любая атака и так ранит только на 6+.
   *
   * Только рукопашные атаки: так в правилах и в тексте BSData.
   */
  '4988-d93e-5034-2b3c': { modelKeywords: ['MELEE_WOUND_PENALTY'] },

  // Telemon: −1 к получаемому урону.
  'e7d8-1c73-7d03-8b62': { damageTakenPenalty: 1 },

  /*
   * Venerable Contemptor: при гибели брось d6, на 2+ восстанови d6 ран.
   * Порог 2+ даёт 5 из 6, то есть правило срабатывает почти всегда — это
   * второй шанс отряду на 8-10 ранах, а не полноценное воскрешение.
   */
  '188b-e48b-29f-1456': { healOnDeath: { chance: 2, sides: 6 } },

  /*
   * Ares Gunship: в любом режиме боя брось d6 за каждую модель целевого
   * юнита, по 1 мортиде за каждую 6.
   *
   * Число бросков зависит от ЗАЩИТНИКА, поэтому эффект живёт на отряде, а не на
   * оружии: в статике про оружие размер цели неизвестен. Моделируется как
   * дополнительный канал урона в resolveWeapon.
   */
  '9335-74d9-ad68-3ff7': {
    mortalDice: { phase: 'all', perDefenderModel: true, table: { 6: { sides: 0, min: 1 } } },
  },

  /*
   * Contemptor-Achillus: в ближнем бою брось d6+2 — на 4-5 наноси d3 мортид,
   * на 6 — ещё 3.
   *
   * Таблица хранит оба исхода отдельно, а не «на 4+ брось d3»: на натуральной
   * 6 правило даёт 3 мортиды ГАРАНТИРОВАННО, тогда как d3 на той же шестёрке
   * дал бы 3 лишь с вероятностью 1/6. Схлопывание в «d3 на 4+» занизило бы
   * способность примерно на треть.
   */
  'db3b-02cd-87a2-3b52': {
    mortalDice: {
      phase: 'melee',
      perDefenderModel: false,
      table: { 4: { sides: 3, min: 0 }, 5: { sides: 3, min: 0 }, 6: { sides: 0, min: 3 } },
    },
  },

  // Anathema Psykana Rhino: +1 рана в начале каждого раунда.
  'd7cb-7d30-715b-50d2': { regeneration: 1 },

  // Pallas Grav-attack: способностей, которые мы моделируем, нет.

  // ── Орки ──────────────────────────────────────────────────────────────────
  // ID — из `public/BSData/wh40k-11e/Orks.json`: Boss Snikrot e651-…,
  // Ghazghkull Thraka 4ea0-…, Mozrog Skragbad b42b-…, Nazdreg 80c4-…,
  // Wazdakka Gutsmek 2ab7-…, Zodgrod Wortsnagga ce45-…, Gretchin de8f-….
  //
  // Отдельные правила орков, которые разбираются из данных, платить не нужно:
  // Deep Strike, Infiltrators, Stealth, Da Boss (+1CP вожаку), SMOKE и
  // Lone Operative у Mozrog/Wazdakka — всё это уже в detectUtilityFlags либо
  // в кейвордах. Здесь только то, что разбор не достаёт.

  /*
   * Boss Snikrot: Lone Operative и «в резерв, потом обратно» каждый раунд.
   *
   * Infiltrators и Stealth оплачены общим разбором (Infiltrator, Stealth),
   * поэтому вручную они не дублируются. Остаётся неразобранное: невидимость
   * дальше 12" и невозможность целиться непрямым огнём (Lone Operative) плюс
   * Kunnin’ Infiltrator — отряд уходит в стратегические резервы в конце фазы
   * боя и входит обратно ingress move (Deff from the Shadows). Это не разовый
   * ввод, а полный выход из боя и возврат в него по желанию.
   */
  'e651-5901-35e5-dc35': {
    utilityFlags: [
      {
        id: 'Orks_Boss_Snikrot',
        reason:
          'Lone Operative (невидимость дальше 12", мимо непрямого огня) и уход в резерв с ingress move каждый раунд',
      },
    ],
  },

  /*
   * Ghazghkull Thraka: Prophet of Da Great Waaagh!
   *
   * Аура «+1 к попаданию и ранению рукопашной» действует на любую дружественную
   * ORKS-UNIT в пределах 6", то есть на весь отряд в радиусе, а не на
   * «лидера и присоединённый юнит», как умеет LeaderAura. Подставлять вместо
   * неё более узкую ауру значило бы заплатить не за ту способность, поэтому
   * аура оплачена флагом целиком.
   *
   * «Da Boss» (+1CP вожаку) в флаг не входит: он разбирается по имени правила
   * и уже платит 2 балла сам (Da_Boss).
   */
  '4ea0-6b70-c17c-bc00': {
    utilityFlags: [
      {
        id: 'Orks_Ghazghkull_Thraka',
        reason: 'Prophet of Da Great Waaagh!: +1 к попаданию и ранению рукопашной всем ORKS в 6"',
      },
    ],
  },

  /*
   * Mozrog Skragbad: Da Bigger Dey Iz… — рукопашные атаки по MONSTER/VEHICLE
   * перебрасывают ранение.
   *
   * Переброс ПОЛНЫЙ («can re-roll wounds rolls»), а не «единички», и с условием
   * на цель — оба конца выражены одним кейвордом [REROLL WOUNDS:
   * MONSTER/VEHICLE], который читает rules.ts по кейвордам защитника. Раньше
   * здесь стояло `rerollWoundOn: [1]`: это и перебрасывало не всё, и работало
   * по любой цели — то есть двойное приближение в плюс.
   *
   * Кейворд висит на рукопашном оружии (у Mozrog это Big Chompa’s Jaws и
   * оба профиля Gutrippa), потому что способность говорит именно о рукопашных
   * атаках, а Thump Gun её не касается.
   *
   * Флаг платит за то, что осталось за пределами расчёта: Beast Snagga
   * Following (Lone Operative, пока он рядом со своими) и One Last Kill — ещё
   * одна драка в той же фазе боя после гибели модели. Второе структурно не
   * смоделировать: симуляция не теряет модели атакующего (см. simulateBattle),
   * а способность срабатывает ровно на этом.
   */
  'b42b-ea0-38f1-6300': {
    meleeWeaponKeywords: ['Reroll wounds: MONSTER/VEHICLE'],
    utilityFlags: [
      {
        id: 'Orks_Mozrog_Skragbad',
        reason:
          'Beast Snagga Following (Lone Operative рядом со своими) и One Last Kill: ещё одна драка в фазе боя после смерти',
      },
    ],
  },

  /*
   * Nazdreg: Kustom Blasta X стреляет всеми тремя профилями сразу (Skorcha,
   * Gatler и Shoota), поэтому в отряде три дальнобойных ствола, а не один —
   * см. поле allProfilesOn. В BSData этого правила нет вовсе, оно приходит
   * руками, поэтому и перебор loadout'ов по этим профилям выключен.
   *
   * Флаг платит за то, что в модели не осталось: Know-wotz выдаёт
   * присоединённым Meganobz Deep Strike и [IGNORES COVER] (у присоединённого
   * юнита в LeaderConditional нет места для дальнобойных кейвордов), а также за
   * Supreme Kunnin' (D6 ход в фазе противника) и снятие battle-shock.
   */
  '80c4-14b2-d02d-d289': {
    allProfilesOn: ['blasta x'],
    utilityFlags: [
      {
        id: 'Orks_Nazdreg',
        reason:
          'Know-wotz присоединённым Meganobz (Deep Strike и IGNORES COVER) и Supreme Kunnin: D6 ход в фазе противника',
      },
    ],
  },

  /*
   * Wazdakka Gutsmek: Deadly Demise 6 — при гибели ЛЮБОЙ модели его отряда
   * каждый отряд в пределах 6" получает 6 мортид. Это доска, а не урон: такой
   * отряд снимает модели с чужих отрядов, не вступая в бой.
   *
   * В расчёте смоделировать нечего: симуляция не теряет модели атакующего
   * (см. simulateBattle), а способность срабатывает именно на этом. Поэтому
   * вся ценность идёт флагом. Smoke и Deep Strike платят отдельно, разбором.
   */
  '2ab7-ab71-0af4-5d39': {
    utilityFlags: [
      {
        id: 'Orks_Wazdakka_Gutsmek',
        reason: 'Deadly Demise 6: гибель модели в отряде — 6 мортид каждому отряду в 6"',
      },
    ],
  },

  /*
   * Zodgrod Wortsnagga → Gretchin: Super Runts даёт присоединённым гретчинам
   * +1 A, +1 WS и +1 S на Scavenged Shivs (Super Runts же делает их отряд
   * riled up — это визуальный переключатель, числовой эффект не считается).
   *
   * Запись висит на ГРЕТЧИНЕ, а не на Zodgrod: правило двустороннее — отряд
   * получает бонус только пока ведёт именно этот лидер. Рукопашное оружие у
   * гретчина одно (Scavenged Shivs), поэтому «всё рукопашное» здесь точно
   * равно «шивы», и таргетить по имени ствола не нужно.
   */
  'de8f-24f9-c543-92b7': {
    withLeader: {
      leaderIds: ['ce45-db08-3795-18a9'],
      meleeWeaponStats: { attacks: 1, skill: 1, strength: 1 },
    },
  },

};

/** Ручные способности юнита; пустой объект, если юнита в слое нет. */
export function manualAbilityOf(unitId: string): ManualAbility | null {
  return MANUAL_ABILITIES[unitId] ?? null;
}

/**
 * Опции перебросов боя, объявленные ручным слоем (Repentia, Retributor,
 * Insidiants, Novitiate).
 *
 * У большинства юнитов возвращает пустой объект — это дешёвый путь, поэтому
 * его можно звать на каждом юните при расчёте тирлиста.
 *
 * Ограничение по фазе (`rerollPhase`) соблюдается так: переброс «только в
 * рукопашной» не выдаётся в режиме 'ranged', и наоборот. В режиме 'combined'
 * обе фазы считаются одним прогоном, поэтому reroll применяется в обоих — иначе
 * пришлось бы разрезать прогон, что изменило бы всю методику подсчёта.
 */
export function rerollOptionsOf(
  unitId: string,
  mode: 'ranged' | 'melee' | 'combined' = 'combined'
): { rerollHitOn?: number[]; rerollWoundOn?: number[] } {
  const ability = MANUAL_ABILITIES[unitId];
  // Проверять надо ОБА вида переброса. Раньше стояло только `rerollHitOn === undefined`,
  // и юнит, у которого есть лишь переброс ранения (Custodian Guard, Allarus,
  // Aquilon, Adrasite), получал пустые опции целиком — тихо, без ошибки.
  if (ability === undefined) return {};
  if (ability.rerollHitOn === undefined && ability.rerollWoundOn === undefined) return {};
  const scope = ability.rerollPhase;
  if (scope !== undefined && scope !== null && mode !== 'combined' && scope !== mode) return {};
  return { rerollHitOn: ability.rerollHitOn, rerollWoundOn: ability.rerollWoundOn };
}

/**
 * Применяет ауру лидера к отряду моделей.
 *
 * Одна функция на оба случая — лидер получает ауру на СЕБЯ, присоединённый
 * юнит на СЕБЯ. Это важно: у Sororitas почти все способности «себе и юниту»,
 * и расщеплять это на два разных вызова означало бы разойтись в логике.
 *
 * @param models модели, к которым применяется аура
 * @param aura ручная аура
 * @param ownKeywords кейворды отряда лидера; аура добавляет STEALTH в отряд
 * @param forAttachedUnit true — модели ИМЕННО присоединённого юнита: тогда
 *   дополнительно применяются `unitWeaponKeywords`, которые лидеру не полагаются
 * @returns новые модели и пополненный список кейвордов отряда
 */
export function applyAuraToModels(
  models: CombatModel[],
  aura: LeaderAura,
  ownKeywords: string[] = [],
  forAttachedUnit = false
): { models: CombatModel[]; keywords: string[] } {
  const keywords = aura.stealth === true && !ownKeywords.includes('STEALTH')
    ? [...ownKeywords, 'STEALTH']
    : ownKeywords;

  const next = models.map((model) => {
    const withStats: CombatModel = {
      ...model,
      // FNP: аура не понижает уже имеющийся (берётся лучший порог).
      fnp: aura.fnp === undefined ? model.fnp : bestFnp(model.fnp, aura.fnp),
      fnpScope: aura.fnp === undefined ? model.fnpScope : 'all',
      save: pickBest(model.save, aura.saveAtLeast, false),
      invuln: pickBest(model.invuln, aura.invulnAtLeast, false),
    };
    // Кейворд MELEE_EVASION: −1 к попаданию рукопашными по этой модели.
    // Junith Eruita даёт его и себе, и присоединённому юниту.
    const modelKeywords = new Set(withStats.keywords);
    if (aura.stealth === true) modelKeywords.add('MELEE_EVASION');
    // MELEE_AP_EVASION: рукопашные атаки по этой модели теряют столько AP.
    // Valerian даёт его и себе, и присоединённому юниту. Читает rules.ts —
    // поэтому кейворд и лежит на модели, а не на оружии.
    if (aura.meleeApWorsening !== undefined && aura.meleeApWorsening > 0) {
      modelKeywords.add('MELEE_AP_EVASION');
    }
    const withKeywords = { ...withStats, keywords: [...modelKeywords] };

    return {
      ...withKeywords,
      weapons: withKeywords.weapons.map((weapon) => applyAuraToWeapon(weapon, aura, forAttachedUnit)),
    };
  });
  return { models: next, keywords };
}

/** Лучший из двух порогов FNP; большее число = более строгий (полезнее). */
function bestFnp(current: number | null, granted: number): number | null {
  if (current === null) return granted;
  return Math.max(current, granted);
}

/**
 * Приводит сейв к «не хуже указанного».
 *
 * `lowerIsBetter` = true для invsv (4+ лучше 3+), false для обычного сейва
 * (2+ лучше 3+). Значение применяется как порог: Math.min с имеющимся.
 */
function pickBest(current: number | null, atLeast: number | undefined, lowerIsBetter: boolean): number | null {
  if (atLeast === undefined) return current;
  if (current === null) return atLeast;
  return lowerIsBetter ? Math.max(current, atLeast) : Math.min(current, atLeast);
}

/**
 * Аура на одном оружии.
 *
 * Одноразовые эффекты (onceMelee*) здесь НЕ применяются намеренно: они
 * считаются отдельной дельтой в строке юнита и не влияют ни на бой, ни на тир.
 */
function applyAuraToWeapon(
  weapon: CombatWeapon,
  aura: LeaderAura,
  forAttachedUnit = false
): CombatWeapon {
  const next: CombatWeapon = { ...weapon };
  if (aura.extraAttacks !== undefined && weapon.attacks !== null) {
    next.attacks = { ...weapon.attacks, count: weapon.attacks.count + aura.extraAttacks };
  }
  if (aura.toHit !== undefined && weapon.skill !== null) {
    next.skill = Math.max(2, weapon.skill - aura.toHit);
  }
  const own = parseKeywords(aura.weaponKeywords ?? []);
  // Кейворды отряда — только присоединённому юниту: они идут вместе с ним в бой,
  // тогда как `weaponKeywords` (LANCE) остаётся на оружии самого лидера.
  const unit = forAttachedUnit ? parseKeywords(aura.unitWeaponKeywords ?? []) : [];
  const extra = [...own, ...unit].filter(
    (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
  );
  if (extra.length > 0) next.keywords = [...weapon.keywords, ...extra];
  return next;
}

/**
 * Копия отряда с ВКЛЮЧЁННЫМИ одноразовыми эффектами.
 *
 * Нужна исключительно для расчёта дельты: сравнив прогон с ней и без, получаем
 * «сколько очков стоит одноразовая способность». В сам бой она не идёт — иначе
 * юнит получал бы постоянный бафф за разовую способность, а это искажало бы
 * и норму урона, и место в тире.
 */
export function withOnceEffects(unit: CombatUnit): CombatUnit {
  const ability = manualAbilityOf(unit.id);
  const aura = ability?.aura;
  // Одноразовые эффекты живут на двух уровнях: в ауре (Trajann, Shield-Captain —
  // они идут от способности персонажа) и прямо в способности (Allarus-щит,
  // Custodian Guard). Уровень выбран по тому, откуда правило приходит в бой.
  // Третий источник — сами стволы [ONE SHOT]: их флаг снимается здесь, и залп
  // попадает в one-shot дельту (см. CombatWeapon.onceOnly).
  const hasOnce =
    (aura?.onceMeleeAttacks ?? 0) > 0 ||
    (aura?.onceMeleeStrength ?? 0) > 0 ||
    (aura?.onceMeleeKeywords ?? []).length > 0 ||
    (ability?.onceRangedKeywords ?? []).length > 0 ||
    ability?.onceFnp !== undefined ||
    ability?.onceDamageCapPerRound !== undefined ||
    ability?.onceDevastating === true ||
    ability?.onceExtraRangedVolley === true ||
    unit.models.some((model) => model.weapons.some((weapon) => weapon.onceOnly === true));
  if (!hasOnce) return unit;
  // Разовые кейворды дальнобойному оружию: список одинаков для всех моделей,
  // поэтому разбирается один раз на весь запуск, а не внутри map по моделям.
  const rangedOnce = parseKeywords(ability?.onceRangedKeywords ?? []);
  return {
    ...unit,
    models: unit.models.map((model) => {
      const next: CombatModel = {
        ...model,
        weapons: model.weapons.map((w) => {
          const withMelee = applyOnceEffects(w, aura);
          // [ONE SHOT]: в копии ствол перестаёт быть одноразовым — simulateRound
          // снова включает его в бой, и разница прогонов и есть цена залпа.
          const steady = withMelee.onceOnly === true ? { ...withMelee, onceOnly: false } : withMelee;
          // Только стрельба: правило говорит о ranged-оружии, и рукопашному
          // копью этот кейворд достаться не должен.
          if (rangedOnce.length === 0 || w.kind !== 'ranged') return steady;
          const extra = rangedOnce.filter(
            (keyword) => !steady.keywords.some((existing) => existing.name === keyword.name)
          );
          return extra.length === 0 ? steady : { ...steady, keywords: [...steady.keywords, ...extra] };
        }),
      };
      if (ability?.onceFnp !== undefined) {
        // Living Fortress: FNP один раз до конца фазы. Постоянным его делать
        // нельзя (см. поле onceFnp) — здесь он нужен только ради дельты.
        next.fnp = model.fnp === null ? ability.onceFnp : Math.max(model.fnp, ability.onceFnp);
        // Область из способности важнее: 'mortals' ограничивает и не защищает.
        next.fnpScope = 'all';
      }
      if (ability?.onceDamageCapPerRound !== undefined) {
        next.damageCapPerRound = ability.onceDamageCapPerRound;
      }
      if (ability?.onceDevastating === true) {
        // Sagittarum: разовые Devastating Wounds всему оружию. Кейворд ставится
        // и на рукопашное, и на дальнобойное — правило говорит об оружии отряда,
        // а не о каком-то одном клинке.
        next.weapons = next.weapons.map((w) => {
          const extra = parseKeywords(['Devastating Wounds']).filter(
            (keyword) => !w.keywords.some((existing) => existing.name === keyword.name)
          );
          return extra.length === 0 ? w : { ...w, keywords: [...w.keywords, ...extra] };
        });
      }
      if (ability?.onceExtraRangedVolley === true) {
        // «Стреляет повторно всем, что есть»: один дополнительный залп
        // дальнобойным оружием. В замере это удвоение числа атак — ровно то,
        // что даёт второй залп в том же раунде.
        next.weapons = next.weapons.map((w) =>
          w.kind === 'ranged' && w.attacks !== null
            ? { ...w, attacks: { ...w.attacks, count: w.attacks.count * 2 } }
            : w
        );
      }
      return next;
    }),
  };
}

/** Одноразовые эффекты на одном оружии: +атаки/+сила и кейворды в рукопашной. */
function applyOnceEffects(weapon: CombatWeapon, aura: LeaderAura | undefined): CombatWeapon {
  const next: CombatWeapon = { ...weapon };
  if (aura !== undefined && weapon.kind === 'melee') {
    if (aura.onceMeleeAttacks !== undefined && weapon.attacks !== null) {
      const bonus = Math.round(aura.onceMeleeAttacks / ONCE_DIVISOR);
      next.attacks = { ...weapon.attacks, count: weapon.attacks.count + bonus };
    }
    if (aura.onceMeleeStrength !== undefined && weapon.strength !== null) {
      const bonus = Math.round(aura.onceMeleeStrength / ONCE_DIVISOR);
      next.strength = weapon.strength + bonus;
    }
    if ((aura.onceMeleeKeywords ?? []).length > 0) {
      const extra = parseKeywords(aura.onceMeleeKeywords!).filter(
        (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
      );
      if (extra.length > 0) next.keywords = [...weapon.keywords, ...extra];
    }
  }
  return next;
}
