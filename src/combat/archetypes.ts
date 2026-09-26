/**
 * Шаблоны основных типов юнитов 11-й редакции.
 *
 * Зачем: одинаковая цифра «урон в раунд» для всех юнитов бессмысленна —
 * урон зависит от того, во что стреляют и бьют. Поэтому вводятся архетипы:
 * эталонная цель с типичными T/W/Sv, числом моделей и кейвордами. Урон
 * считается по каждому архетипу отдельно, а затем усредняется по весам —
 * так в оценке юнита участвуют и пехота, и техника, и монстры.
 *
 * Шаблоны типов юнитов — ТИПЫ ТЕПЕРЬ ПРИХОДЯТ ИЗ ДАННЫХ.
 *
 * Зачем: одинаковая цифра «урон в раунд» для всех юнитов бессмысленна —
 * урон зависит от того, во что стреляют и бьют. Каждый юнит сравнивается с
 * набором эталонных целей, и агрегированные метрики считаются по ним.
 *
 * ИСТОРИЯ: раньше здесь был закрытый список из 13 типов, заданных вручную
 * (infantry, walker, flyer, …). Он оказался кривым: корзина infantry
 * объединяла и обычную пехоту, и героев, и фланг-инфантрию, а flyer,
 * transport и vehicle различались там, где сами данные не различают.
 * Из-за этого медианы по корзинам давали несуществующих юнитов, а модель
 * приходилось чинить вручную.
 *
 * Теперь типы выводятся k-means по реальным даташитам BSData и лежат в
 * clusters.generated.ts; набор и число типов — следствие данных, а не нашего
 * решения. См. scripts/build-clusters.ts.
 *
 * Известная потеря: кейворды кластера берутся по большинству его юнитов, так
 * что в кластере VEHICLE (T9/W11) часть участников летает, а FLY не
 * набирает порога. Это осознанно: антифайерные бонусы у части техники
 * поэтому не срабатывают.
 *
 * Это допущения модели, а не точная копия кодекса: у конкретных отрядов
 * характеристики отличаются (Cadian Shock Troops Sv2+, Hormagaunts W1).
 * Цель эталона — дать устойчивую, сопоставимую основу для тирлиста.
 */

import { CLUSTER_PROFILES } from './clusters.generated.ts';
import type { ArchetypeGroup, ArchetypeId, ClusterProfile } from './clusterProfiles.ts';
import type { CombatModel, CombatUnit } from './types.ts';

export { CLUSTER_PROFILES } from './clusters.generated.ts';

export type { ArchetypeGroup, ArchetypeId, ClusterProfile } from './clusterProfiles.ts';

/** Эталонная цель типа юнита. */
export interface UnitArchetype extends ClusterProfile {
  /** Зачем нужен этот тип (для отчётов и документации). */
  description: string;
  /**
   * Может ли цель двигаться/быть в зоне боя (влияет на не-MONSTER/VEHICLE
   * условия). По умолчанию считаем, что да: осаждённый отряд в реальности всё
   * равно защищает объекты, а ошибочное срабатывание условия стоит дороже
   * пропущенного.
   */
  defaultEngaged?: boolean;
}

/** Эталонные типы, выведенные из данных. */
export const ARCHETYPES: readonly UnitArchetype[] = CLUSTER_PROFILES.map((profile) => ({
  ...profile,
  description: `Тип из k-means: ${profile.sample} реальных юнитов, медиана T${profile.toughness} W${profile.wounds}`,
}));

/** Идентификаторы типов-пехоты (для парадигмы «против пехоты»). */
export const INFANTRY_ARCHETYPES: readonly ArchetypeId[] = ARCHETYPES.filter(
  (archetype) => archetype.group === 'infantry'
).map((archetype) => archetype.id);

/** Идентификаторы типов-техники. */
export const ARMOR_ARCHETYPES: readonly ArchetypeId[] = ARCHETYPES.filter(
  (archetype) => archetype.group === 'armor'
).map((archetype) => archetype.id);

/**
 * Типы заданной группы, отсортированные от слабого к сильному.
 *
 * Нужно отчётам и тестам: обращаться к типам по смыслу («самая хрупкая
 * пехота», «самая живучая техника»), а не по ручному списку id — он
 * рассыпается при каждой смене K.
 */
export function archetypesByGroup(group: ArchetypeGroup): UnitArchetype[] {
  return ARCHETYPES.filter((archetype) => archetype.group === group).sort(
    (a, b) => a.toughness * a.wounds - b.toughness * b.wounds
  );
}


/**
 * Копия эталонов с изменённым числом моделей — для sensitivity-анализа.
 *
 * Размер эталона цели задаёт, СКОЛЬКО урона нужно потратить на её уничтожение,
 * и поэтому напрямую влияет на оценку. Юнит, ранг которого скачет при ±20%
 * моделей, зависит от произвольного допущения о размере цели.
 *
 * Стоимость (`points`) масштабируется пропорционально, иначе «уничтоженные
 * очки» по targets перестали бы быть согласованными с числом моделей.
 *
 * ВАЖНО: масштабируются только ОТРЯДНЫЕ эталоны (models >= MIN_SQUAD_TARGET).
 * Причина: число моделей округляется, и для одиночной цели 1 модель × 1.2 =
 * round(1.2) = 1, то есть возмущение равно нулю. Смешивание «+20% у пехоты»
 * с «+0% у техники» не проверяет устойчивость модели, а измеряет эффект
 * округления: наблюдаемый разброс перцентилей при этом ~48 вместо нескольких,
 * и флаг чувствительности теряет смысл.
 */
export const MIN_SQUAD_TARGET = 2;

export function scaleArchetypeModels(
  archetypes: readonly UnitArchetype[],
  factor: number
): UnitArchetype[] {
  return archetypes.map((archetype) => {
    if (archetype.models < MIN_SQUAD_TARGET) return { ...archetype };
    const models = Math.max(MIN_SQUAD_TARGET, Math.round(archetype.models * factor));
    return {
      ...archetype,
      models,
      points: Math.max(1, Math.round((archetype.points * models) / archetype.models)),
    };
  });
}

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
 * Определяет тип реального отряда — БЛИЖАЙШИМ ЦЕНТРОИДОМ в том же
 * признаковом пространстве, в котором строились кластеры.
 *
 * Раньше здесь стояла лестница правил по кейвордам (FORTIFICATION →
 * BATTLESUIT → TERMINATOR → …). Она и была источником кривой типизации:
 * порядок правил решал за данные, а «cavalry» и «infantry-veteran» вообще
 * различались вручную. Теперь правил нет — только расстояние до центроидов.
 *
 * Расстояние считается в z-score, иначе признак «очки на модель» (среднее
 * ~36, σ ~40) перевешивал бы T и W (σ единиц) и всё сводил к деньгам.
 * Стандартизация берётся из тех же кластеров, что и при обучении, иначе
 * ближайшим оказывался бы не тот тип.
 */
export function archetypeOf(unit: CombatUnit, points: number): UnitArchetype | null {
  if (ARCHETYPES.length === 0) return null;
  const first = unit.models[0];
  if (first === undefined) return null;
  const modelCount = unit.models.length;
  // Признаки юнита — те же шесть, по которым строились кластеры.
  const observed: readonly number[] = [
    first.toughness,
    first.wounds,
    // null («сейва нет») кодируется как 6 — так же, как в обучении.
    first.save ?? NO_SAVE,
    first.invuln ?? NO_SAVE,
    modelCount,
    points / modelCount,
  ];
  let best: UnitArchetype | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const archetype of ARCHETYPES) {
    const reference: readonly number[] = [
      archetype.toughness,
      archetype.wounds,
      archetype.save ?? NO_SAVE,
      archetype.invuln ?? NO_SAVE,
      archetype.models,
      archetype.points / archetype.models,
    ];
    let distance = 0;
    for (let i = 0; i < observed.length; i += 1) {
      const delta = (observed[i] - reference[i]) / SCALES[i];
      distance += delta * delta;
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = archetype;
    }
  }
  return best;
}

/** «Сейва нет» в признаковом пространстве. */
const NO_SAVE = 6;

/**
 * Масштабы (σ) признаков — константы, а не пересчёт по текущему набору.
 *
 * Почему так: σ зависит от выборки, и если считать его на лету, один и тот
 * же юнит мог бы попасть в разные типы в разных прогонах (сейчас — на
 * полном наборе, потом — на отфильтрованном по фракции). Значения взяты из
 * разброса локальной базы wh40k-11e; при смене базы их стоит перегенерировать
 * вместе с clusters.generated.ts.
 *
 * Порядок соответствует unitFeatureVector в clustering.ts:
 * T, W, Sv, InSv, models, очки на модель.
 */
const SCALES: readonly number[] = [2.5, 3.5, 1.2, 1.2, 4.5, 45];
