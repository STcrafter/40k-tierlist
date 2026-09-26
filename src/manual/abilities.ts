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
import type { CombatModel, CombatUnit, CombatWeapon } from '../combat/types.ts';

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
] as const;

export type ManualUtilityFlagId = (typeof MANUAL_UTILITY_FLAG_IDS)[number];

/** Ручной флаг стратегической полезности. */
export interface ManualUtilityFlag {
  id: ManualUtilityFlagId;
  points: number;
  /** Почему флаг выставлен — попадает в отчёт, чтобы список читался глазами. */
  reason: string;
}

/** Дополнительные мортиды от способности, действующие только в своей фазе. */
export interface MortalDamageBonus {
  amount: number;
  phase: 'ranged' | 'melee';
}

/** Кейворд, выдаваемый оружию моделей. */
export interface WeaponKeywordGrant {
  /** Сырые строки BSData, разбираются через keywords.ts. */
  keywords: string[];
  /**
   * Имена моделей, к оружию которых добавляется кейворд.
   * null — всем моделям отряда.
   */
  models: string[] | null;
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
  /** Лидер и юнит перебрасывают неудачные броски попадания (1 = «of a 1»). */
  rerollHitOn?: number[];
  /** Лидер и юнит перебрасывают неудачные броски ранений. */
  rerollWoundOn?: number[];
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
 * Одноразовые эффекты оружию лидера: +N атак и +M силы в рукопашной.
 *
 * В бой они НЕ применяются: см. ONCE_DIVISOR. Значения хранятся здесь, чтобы
 * по ним отдельно считалась дельта (см. onceEffectDelta), а не чтобы искажать
 * боевой расчёт.
 */
  onceMeleeAttacks?: number;
  onceMeleeStrength?: number;
  /** Кейворд оружию лидера, действующий разово: Devastating у Canoness с ранцом. */
  onceMeleeKeywords?: string[];
}

export interface ManualAbility {
  /**
   * Кейворды, добавляемые собственному оружию отряда.
   *
   * @deprecated Используйте `aura.weaponKeywords`: у большинства лидеров
   * Sororitas способность действует и на присоединённый юнит, а этот блок
   * применяется только к самому юниту.
   */
  weaponKeywords?: WeaponKeywordGrant[];
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
  /** −N ран у каждой модели отряда (Celestian Sacresants: −1). */
  woundsPenalty?: number;
  /** Кейворды рукопашному оружию отряда (Sanctifiers: Sustained Hits 1). */
  meleeWeaponKeywords?: string[];
  /**
   * Сколько моделей отряда лидер возвращает в бой за раунд, пока сам жив
   * (Sanctifiers + Ministorum Priest: D3). Ставится на модели ЛИДЕРА.
   */
  reviveCount?: number;
}

/**
 * Сколько моделей отряда лидера возвращать в присоединённый юнит за раунд.
 *
 * Считается по моделям, у которых `reviveLeader === true`: лидер остаётся в
 * строю, пока жив (Hospitaller), и каждую фазу командования возвращает одну
 * убитую модель юнита с полными ранами.
 */
export function leaderReviveCount(unit: CombatUnit): number {
  return unit.models.filter((model) => model.reviveLeader === true).length;
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
        points: 2,
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
        points: 2,
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
        points: 3,
        reason: 'регенерация ран и одноразовое воскрешение с полным запасом ран',
      },
    ],
  },

  // Triumph of Saint Katherine — большой стратегический флаг: способность
  // меняет игру сильнее, чем её собственный урон.
  '9f5f-d769-7900-c8a1': {
    utilityFlags: [
      {
        id: 'Triumph_Relic_Blessing',
        points: 4,
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
        points: 2,
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
        points: 2,
        reason: '+1 атака всему оружию (Fists of Bzuulth) себе и присоединённому юниту',
      },
    ],
  },

  // Morvenn Vahl: переброс попаданий и ранений себе и юниту, +3 атаки и LANCE
  // на её собственном оружии. Флага нет: перебросы — это уже боевая ценность,
  // платить за неё в utility значило бы удвоить смоделированное.
  '7188-4d20-8216-c68a': {
    aura: { rerollHitOn: [1], rerollWoundOn: [1], extraAttacks: 3, weaponKeywords: ['Lance'] },
  },

  // Canoness: инвульнити 2+ на один ход (себе) и +1 к попаданию себе и юниту.
  'c338-14f9-4ee-f223': {
    aura: { toHit: 1 },
    utilityFlags: [
      {
        id: 'Sororitas_Canoness_Aura',
        points: 2,
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
        points: 2,
        reason: 'одноразовые +3 атаки и Devastating Wounds на рукопашное оружие модели',
      },
    ],
  },

  // Dialogus: только стратегическая ценность.
  '91b8-3ccb-de30-6e54': {
    utilityFlags: [
      {
        id: 'Sororitas_Dialogus',
        points: 2,
        reason: 'проповедь: раздаёт отрядные бонусы и держит цель на себе',
      },
    ],
  },

  // Dogmata: только стратегическая ценность.
  '76b1-f4d1-b2f0-6949': {
    utilityFlags: [
      {
        id: 'Sororitas_Dogmata',
        points: 2,
        reason: 'собор: аура на Command/shader и лечение в фазе командования',
      },
    ],
  },

  // Hospitaller: FNP 5+ себе и юниту + возврат 1 модели в юнит за ход, пока
  // Hospitaller жив. FNP — смоделированная величина, флаг за неё не платится.
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
        points: 1,
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
        points: 3,
        reason: 'универсальный боец с Condemnor у офицера: стрельба, рукопашная, спецоружие',
      },
    ],
  },

  '1001-80ff-c9a8-5d9b': {
    utilityFlags: [
      {
        id: 'Sororitas_Immolator',
        points: 2,
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
        points: 1,
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
        points: 2,
        reason: 'гвардия части с усиленным офицером и заголовком',
      },
    ],
  },

  '7d63-7b55-a632-6a10': { rerollHitOn: [1], rerollWoundOn: [1], rerollPhase: 'melee' },

  // Reroll 1 на попадания и ранения ТОЛЬКО при стрельбе.
  'c49d-f150-4b3-c118': {
    rerollHitOn: [1],
    rerollWoundOn: [1],
    rerollPhase: 'ranged',
    utilityFlags: [
      {
        id: 'Sororitas_Retributors',
        points: 1,
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
        points: 2,
        reason: 'Miraculist: Sustained Hits 1 и возврат D3 моделей при святом Министоруме',
      },
    ],
  },

  'bee9-172b-7db7-f748': {
    utilityFlags: [
      {
        id: 'Sororitas_Seraphim',
        points: 1,
        reason: 'прыгающие и летающие с рукопашной в ближней и глухой стрельбой',
      },
    ],
  },

  '4269-a229-1461-67d0': {
    rerollHitOn: [1],
    utilityFlags: [
      {
        id: 'Sororitas_Novitiates',
        points: 2,
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
        points: 1,
        reason: 'тяжёлая техника с парой скорострельных автопушек',
      },
    ],
  },

  '684e-4dd3-340a-23ee': {
    utilityFlags: [
      {
        id: 'Sororitas_Exorcist',
        points: 1,
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
        points: 2,
        reason: 'автопопадание ближнего огня и FNP 5+ при низком Т',
      },
    ],
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
  if (ability === undefined || ability.rerollHitOn === undefined) return {};
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
 * @returns новые модели и пополненный список кейвордов отряда
 */
export function applyAuraToModels(
  models: CombatModel[],
  aura: LeaderAura,
  ownKeywords: string[] = []
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
    const withKeywords = { ...withStats, keywords: [...modelKeywords] };

    return {
      ...withKeywords,
      weapons: withKeywords.weapons.map((weapon) => applyAuraToWeapon(weapon, aura)),
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
function applyAuraToWeapon(weapon: CombatWeapon, aura: LeaderAura): CombatWeapon {
  const next: CombatWeapon = { ...weapon };
  if (aura.extraAttacks !== undefined && weapon.attacks !== null) {
    next.attacks = { ...weapon.attacks, count: weapon.attacks.count + aura.extraAttacks };
  }
  if (aura.toHit !== undefined && weapon.skill !== null) {
    next.skill = Math.max(2, weapon.skill - aura.toHit);
  }
  if ((aura.weaponKeywords ?? []).length > 0) {
    const extra = parseKeywords(aura.weaponKeywords!).filter(
      (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
    );
    if (extra.length > 0) next.keywords = [...weapon.keywords, ...extra];
  }
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
  if (aura === undefined) return unit;
  const hasOnce =
    (aura.onceMeleeAttacks ?? 0) > 0 ||
    (aura.onceMeleeStrength ?? 0) > 0 ||
    (aura.onceMeleeKeywords ?? []).length > 0;
  if (!hasOnce) return unit;
  return {
    ...unit,
    models: unit.models.map((model) => ({
      ...model,
      weapons: model.weapons.map((weapon) => applyOnceEffects(weapon, aura)),
    })),
  };
}

/** Одноразовые эффекты на одном оружии: +атаки/+сила и кейворды в рукопашной. */
function applyOnceEffects(weapon: CombatWeapon, aura: LeaderAura): CombatWeapon {
  const next: CombatWeapon = { ...weapon };
  if (weapon.kind === 'melee') {
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
