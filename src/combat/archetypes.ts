/**
 * Шаблоны основных типов юнитов 11-й редакции.
 *
 * Зачем: одинаковая цифра «урон в раунд» для всех юнитов бессмысленна —
 * урон зависит от того, во что стреляют и бьют. Поэтому вводятся архетипы:
 * эталонная цель с типичными T/W/Sv, числом моделей и кейвордами. Урон
 * считается по каждому архетипу отдельно, а затем усредняется по весам —
 * так в оценке юнита участвуют и пехота, и техника, и монстры.
 *
 * Характеристики взяты из правил 11-й редакции и сверены с медианами по
 * реальным даташитам BSData (n — число профилей в базе). Расхождения, найденные
 * такой сверкой и исправленные:
 *   walker  9/8/2  → 10/12/3  (n=147)
 *   vehicle 11/13/2 → 10/11/3  (n=130)
 *   transport 9/10/3 → 11/16/3 (n=74)
 *   flyer   10/14/2 →  9/12/3  (n=139)
 *   fortification 10/12/4 → 12/12/3 (n=36)
 * terminator (5/3/2, n=139) и jetpack (4/2/3, n=90) совпали с медианами.
 *
 * Важнее прочих было Sv: у walker/vehicle/flyer стояло 2+, тогда как медиана
 * BSData — 3+. Sv 2+ существенно живучее, поэтому техника в тирлисте была
 * систематически завышена, а infantry не могла набрать процентов.
 *
 * Это допущения модели, а не точная копия кодекса: у конкретных отрядов
 * характеристики отличаются (Cadian Shock Troops Sv2+, Hormagaunts W1).
 * Цель шаблона — дать устойчивую, сопоставимую основу для тирлиста.
 */

import type { CombatModel, CombatUnit } from './types.ts';

/** Идентификатор типа юнита. */
export type ArchetypeId =
  | 'infantry'
  | 'infantry-veteran'
  | 'swarm'
  | 'terminator'
  | 'jetpack'
  | 'cavalry'
  | 'monster'
  | 'walker'
  | 'vehicle'
  | 'transport'
  | 'flyer'
  | 'battlesuit'
  | 'fortification';

/** Эталонная цель типа юнита. */
export interface UnitArchetype {
  id: ArchetypeId;
  name: string;
  /** Зачем нужен этот тип (для отчётов и документации). */
  description: string;
  /** Число моделей в эталонном отряде. */
  models: number;
  toughness: number;
  wounds: number;
  /** Sv '3+' → 3; null — сейва нет. */
  save: number | null;
  /** InSv '4+' → 4; null — инвулы нет. */
  invuln: number | null;
  /** Кейворды цели в верхнем регистре (важны для [ANTI-X] и [LETHAL HITS]). */
  keywords: string[];
  /**
   * Типичная стоимость эталона в очках — по ней нормируется урон
   * («урон на 100 очков»). Ориентиры: Intercessor Squad 80, Boyz 180,
   * Deathwatch Terminators 330, Deff Dread 130, Leman Russ 160.
   */
  points: number;
  /** Может ли цель двигаться/быть в зоне боя (влияет на не-MONSTER/VEHICLE условия). */
  defaultEngaged?: boolean;
}

/**
 * Эталонные архетипы. `models` — разумный размер для расчёта: рой и пехота
 * берутся по нижней границе типовой «рабочей» численности, одиночные техники и
 * монстры — одной моделью.
 */
export const ARCHETYPES: readonly UnitArchetype[] = [
  {
    id: 'infantry',
    name: 'Пехота',
    description: 'Обычный пехотный отряд: имён, гвардейцы, культисты, ячейки.',
    models: 10,
    toughness: 4,
    wounds: 2,
    save: 3,
    invuln: null,
    keywords: ['INFANTRY', 'BATTLELINE'],
    points: 100,
  },
  {
    id: 'infantry-veteran',
    name: 'Ветеранская пехота',
    description: 'Усиленная пехота с бронёй 2+ и/или большим числом ран.',
    models: 10,
    toughness: 4,
    wounds: 2,
    save: 2,
    invuln: null,
    keywords: ['INFANTRY'],
    points: 180,
  },
  {
    id: 'swarm',
    name: 'Рой',
    description: 'Много мелких моделей с 1 раной: Gaunts, Hormagaunts, Razorbeasts.',
    models: 10,
    toughness: 3,
    wounds: 1,
    save: 6,
    invuln: null,
    keywords: ['INFANTRY', 'SWARM'],
    points: 100,
  },
  {
    id: 'terminator',
    name: 'Терминаторы',
    description: 'Бронированная пехота в терминаторских доспехах, Sv2+ и InSv.',
    models: 5,
    toughness: 5,
    wounds: 3,
    save: 2,
    invuln: 4,
    keywords: ['INFANTRY', 'TERMINATOR'],
    points: 250,
  },
  {
    id: 'jetpack',
    name: 'Джамп-паки',
    description: 'Пехота с джамп-паками: атакует в ближнем бою сразу в свой ход.',
    models: 5,
    toughness: 4,
    wounds: 2,
    save: 3,
    invuln: null,
    keywords: ['INFANTRY', 'JUMP PACK'],
    points: 250,
    defaultEngaged: true,
  },
  {
    id: 'cavalry',
    name: 'Кавалерия',
    description: 'Всадники / мотоциклы: быстрый доступ к рукопашной.',
    models: 5,
    toughness: 5,
    wounds: 5,
    save: 3,
    invuln: null,
    keywords: ['CAVALRY', 'MOUNTED'],
    points: 160,
  },
  {
    id: 'monster',
    name: 'Монстр',
    description: 'Крупная одиночная пехотная/звероподобная модель (T6–8).',
    models: 1,
    toughness: 7,
    wounds: 6,
    save: 3,
    invuln: null,
    keywords: ['MONSTER'],
    points: 100,
  },
  {
    id: 'walker',
    name: 'Шагоход',
    description: 'Дроид-шагоход: Deff Dread, Dreadnought, Knight-подобные.',
    models: 1,
    toughness: 10,
    wounds: 12,
    save: 3,
    invuln: null,
    keywords: ['VEHICLE', 'WALKER'],
    points: 135,
  },
  {
    id: 'vehicle',
    name: 'Техника',
    description: 'Бронированная машина: Leman Russ, Land Raider, аналоги.',
    models: 1,
    toughness: 10,
    wounds: 11,
    save: 3,
    invuln: null,
    keywords: ['VEHICLE'],
    points: 160,
  },
  {
    id: 'transport',
    name: 'Транспорт',
    description: 'Машина для перевозки: Rhino,_TRANSPORT_, Drop Pod.',
    models: 1,
    toughness: 11,
    wounds: 16,
    save: 3,
    invuln: null,
    keywords: ['VEHICLE', 'TRANSPORT'],
    points: 100,
  },
  {
    id: 'flyer',
    name: 'Летающая техника',
    description: 'Авиация и «летуны»: Valkyrie, Stormwings, крейсеры.',
    models: 1,
    toughness: 9,
    wounds: 12,
    save: 3,
    invuln: null,
    keywords: ['VEHICLE', 'FLY'],
    points: 170,
  },
  {
    id: 'battlesuit',
    name: 'Боевые костюмы',
    description: 'Костюмы: T\'au Crisis, Necron Warriors, Skitarii (не-пехота).',
    models: 3,
    toughness: 5,
    wounds: 4,
    save: 3,
    invuln: null,
    keywords: ['VEHICLE', 'BATTLESUIT'],
    points: 350,
  },
  {
    id: 'fortification',
    name: 'Укрепление',
    description: 'Стационарная цель: Bastion, блокпост, храм.',
    models: 1,
    toughness: 12,
    wounds: 12,
    save: 3,
    invuln: null,
    keywords: ['FORTIFICATION'],
    points: 145,
  },
];

/** Архетип по идентификатору; бросает ошибку на неизвестном id. */
export function archetypeById(id: ArchetypeId): UnitArchetype {
  const found = ARCHETYPES.find((archetype) => archetype.id === id);
  if (!found) throw new Error(`Неизвестный архетип: ${id}`);
  return found;
}

/**
 * Собирает боевой отряд-цель из архетипа: `models` одинаковых моделей.
 * Оружия у цели нет — она только принимает урон.
 */
export function targetUnitOf(
  archetype: UnitArchetype,
  overrides: Partial<Pick<UnitArchetype, 'models' | 'toughness' | 'wounds' | 'save' | 'invuln' | 'keywords'>> = {}
): CombatUnit {
  const spec = { ...archetype, ...overrides };
  const models: CombatModel[] = [];
  for (let i = 0; i < spec.models; i += 1) {
    models.push({
      id: `${archetype.id}#${i}`,
      name: archetype.name,
      toughness: spec.toughness,
      wounds: spec.wounds,
      save: spec.save,
      invuln: spec.invuln,
      fnp: null,
      fnpScope: 'all',
      keywords: spec.keywords,
      weapons: [],
    });
  }
  return { id: archetype.id, name: archetype.name, keywords: spec.keywords, models };
}

/**
 * Определяет архетип реального отряда по его кейвордам и характеристикам.
 * Порядок важен: более специфичные кейворды проверяются первыми
 * (терминатор — это пехота, но не рой; транспорт — техника, но не «обычная»).
 *
 * Возвращает null, если отряд не похож ни на один шаблон (например, в базе
 * BSData у части даташитов нет профиля модели — тогда классифицировать нечего).
 */
export function archetypeOf(unit: CombatUnit): UnitArchetype | null {
  const keywords = new Set(unit.keywords);
  const has = (...names: string[]): boolean => names.some((name) => keywords.has(name));

  // Явно маркированные типы.
  if (has('FORTIFICATION')) return archetypeById('fortification');
  if (has('BATTLESUIT')) return archetypeById('battlesuit');
  if (has('TERMINATOR')) return archetypeById('terminator');
  if (has('JUMP PACK')) return archetypeById('jetpack');
  if (has('SWARM')) return archetypeById('swarm');

  // Техника. Порядок «летающая → шагоход → транспорт → машина»: шагоход идёт
  // раньше транспорта, иначе Stompa (T14/W30, есть оба кейворда) уехал бы в
  // транспорт, хотя по живучести это шагоход, а Kill Tank (T12/W24, только
  // Transport) — в машину, а не в типовой T9/W10 транспорт.
  if (has('VEHICLE', 'WALKER', 'AIRCRAFT', 'FRAME')) {
    if (has('FLY')) return archetypeById('flyer');
    if (has('WALKER')) return archetypeById('walker');
    if (has('TRANSPORT')) return archetypeById('transport');
    return archetypeById('vehicle');
  }

  // Звери и монстры по T/W, когда нет машинных кейвордов.
  const first = unit.models[0];
  if (first === undefined) return null;

  // Одиночные герои (Character: Warboss, Beastboss, Ghazghkull Thraka) — это
  // пехота с большим числом ран, но не кавалерия: W ≥ 5 у них следствие доспеха.
  if (first.wounds >= 5 && !has('INFANTRY')) return archetypeById('monster');
  if (has('INFANTRY') && first.wounds >= 5) return archetypeById('infantry-veteran');

  // Кавалерия — только отряд, а не одиночная скоростная машина:
  // Wazdakka Gutsmek (одиночная, T8/W10, [MOUNTED]) — это зверь, не полк всадников.
  if (has('CAVALRY', 'MOUNTED') && unit.models.length >= 3 && first.wounds < 8) {
    return archetypeById('cavalry');
  }

  // Sv3+ — обычная пехота; ветеран начинается с брони 2+.
  if (has('INFANTRY') && first.save !== null && first.save <= 2) {
    return archetypeById('infantry-veteran');
  }
  if (has('INFANTRY')) return archetypeById('infantry');
  return null;
}

