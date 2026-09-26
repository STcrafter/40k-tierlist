/**
 * Генератор типов юнитов из ДАННЫХ: k-means по реальным даташитам BSData.
 *
 *   node scripts/build-clusters.ts
 *
 * Зачем отдельный шаг: типы нужны и серверу (src/), и браузеру (web/), а
 * браузер не читает BSData. Поэтому кластеризация выполняется здесь, один раз,
 * а результат коммитится в src/combat/clusters.generated.ts. Иначе тирлист
 * зависел бы от того, прогоняли ли мы этот скрипт.
 *
 * Про сам подход и его ограничения — в archetypes.ts.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit } from '../src/combat/adapter.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { bestK, chooseK, unitFeatureVector, type Vector } from '../src/combat/clustering.ts';
import { INFANTRY_KEYWORD, type ClusterProfile } from '../src/combat/clusterProfiles.ts';

const outPath = resolve('src/combat/clusters.generated.ts');
const started = Date.now();

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));

interface Sample {
  name: string;
  features: Vector;
  keywords: string[];
  /** Сейвы и инвулы по моделям: нужны для медианы отдельно от признаков. */
  saveValues: number[];
  invulnValues: number[];
}

const samples: Sample[] = [];
for (const datasheet of datasheets) {
  // [Legends] в тирлист не попадает, поэтому и в кластеризацию не должен.
  if (datasheet.name.includes('[Legends]')) continue;
  const adapted = adaptUnit(datasheet, { size: 'min' });
  if (adapted.unit.models.length === 0 || !isEligibleForCalculations(datasheet.name, adapted.points)) {
    continue;
  }
  samples.push({
    name: datasheet.name,
    features: unitFeatureVector(adapted.unit, adapted.points),
    keywords: adapted.unit.keywords,
    saveValues: adapted.unit.models.map((model) => model.save ?? 6),
    invulnValues: adapted.unit.models.map((model) => model.invuln ?? 6),
  });
}
console.log(`Юнитов в кластеризации: ${samples.length}`);

const choices = chooseK(
  samples.map((sample) => sample.features),
  [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
);
for (const choice of choices) {
  console.log(`  K=${String(choice.k).padStart(2)}  силуэт ${choice.silhouette.toFixed(4)}`);
}
const best = bestK(choices);
console.log(`Выбран K=${best.k} (силуэт ${best.silhouette.toFixed(4)})`);

const profiles: ClusterProfile[] = [];
for (let k = 0; k < best.k; k += 1) {
  const members = samples.filter((_, index) => best.labels[index] === k);
  if (members.length === 0) continue;

  // Кейворды — по большинству участников кластера. Это осознанная потеря:
  // в кластере «техника» часть юнитов летает, и FLY не набирает порога.
  // Пользователь подтвердил, что потери в правилах несущественны.
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const keyword of new Set(member.keywords)) {
      counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
    }
  }
  const half = members.length / 2;
  const keywords = [...counts.entries()]
    .filter(([, count]) => count > half)
    .map(([keyword]) => keyword)
    .sort();

  // Профиль берём по МЕДИАНЕ участников, а не по центроиду (= среднему).
  // Среднее по кластеру тянет хвосты: в «героях» один Abaddon (W9) сдвигает
  // среднее, и эталон перестаёт быть похожим на реальный отряд. Ровно та же
  // причина, по которой ручные медианы по плохим корзинам не работали.
  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  };
  const saves = members.flatMap((member) => member.saveValues);
  const invulns = members.flatMap((member) => member.invulnValues);
  const toughness = median(members.map((member) => member.features[0]));
  const wounds = median(members.map((member) => member.features[1]));
  const saveMedian = saves.length > 0 ? median(saves) : null;
  const invulnMedian = invulns.length > 0 ? median(invulns) : null;
  const modelCount = median(members.map((member) => member.features[4]));
  const pointsPerModel = median(members.map((member) => member.features[5]));
  const infantryShare = (counts.get(INFANTRY_KEYWORD) ?? 0) / members.length;
  profiles.push({
    id: '',
    name: '',
    group: infantryShare > 0.5 ? 'infantry' : 'armor',
    keywords,
    models: Math.max(1, Math.round(modelCount)),
    toughness: Math.max(1, Math.round(toughness)),
    wounds: Math.max(1, Math.round(wounds)),
    // null = «сейва нет»: в признаках это кодировалось как 6, и медиана 6 означает,
    // что у большинства юнитов кластера сейва действительно нет.
    save: saveMedian !== null && saveMedian < 6 ? Math.max(2, Math.round(saveMedian)) : null,
    invuln: invulnMedian !== null && invulnMedian < 6 ? Math.max(2, Math.round(invulnMedian)) : null,
    points: Math.max(1, Math.round(modelCount * pointsPerModel)),
    sample: members.length,
  });
}

// Сортируем по живучести: так список читается как «от хрупкой толпы к титану».
profiles.sort(
  (a, b) => a.toughness * a.wounds * a.models - b.toughness * b.wounds * b.models
);
profiles.forEach((profile, index) => {
  profile.id = `cluster-${index + 1}`;
  // Имя — по доминирующим кейвордам: кластеры не имеют «правильных» названий,
  // и выдумывать их значило бы снова навязывать ручную типизацию.
  profile.name = describeCluster(profile);
});

/** Человекочитаемое имя кластера по его геометрии и кейвордам. */
function describeCluster(profile: ClusterProfile): string {
  const { keywords, models, toughness, wounds, save } = profile;
  if (models >= 5) return `Пехота T${toughness} W${wounds}`;
  if (toughness >= 12) return `Титан T${toughness} W${wounds}`;
  if (models >= 3) return `Ополчение T${toughness} W${wounds}`;
  if (toughness >= 9) return `Техника T${toughness} W${wounds}`;
  if (keywords.includes(INFANTRY_KEYWORD)) {
    return save === null ? `Пехота T${toughness} W${wounds}` : `Усиленная пехота T${toughness} W${wounds} Sv${save}+`;
  }
  if (keywords.includes('MONSTER') || keywords.includes('DAEMON')) {
    return `Монстр T${toughness} W${wounds}`;
  }
  return `Одиночная модель T${toughness} W${wounds}`;
}

console.log('\nКластеры:');
for (const profile of profiles) {
  console.log(
    `  ${profile.id.padEnd(10)} n=${String(profile.sample).padStart(4)}  ` +
      `T${profile.toughness} W${profile.wounds} Sv${profile.save ?? '-'} ` +
      `models=${profile.models} pts=${profile.points}  [${profile.group}]  ` +
      profile.keywords.slice(0, 4).join(' ')
  );
}

const body = profiles
  .map((profile) =>
    [
      '  {',
      `    id: ${JSON.stringify(profile.id)},`,
      `    name: ${JSON.stringify(profile.name)},`,
      `    group: ${JSON.stringify(profile.group)},`,
      `    keywords: ${JSON.stringify(profile.keywords)},`,
      `    models: ${profile.models},`,
      `    toughness: ${profile.toughness},`,
      `    wounds: ${profile.wounds},`,
      `    save: ${profile.save ?? 'null'},`,
      `    invuln: ${profile.invuln ?? 'null'},`,
      `    points: ${profile.points},`,
      `    sample: ${profile.sample},`,
      '  },',
    ].join('\n')
  )
  .join('\n');

writeFileSync(
  outPath,
  `/**
 * ТИПЫ ЮНИТОВ, ВЫВЕДЕННЫЕ ИЗ ДАННЫХ. Файл генерируется — правьте генератор.
 *
 * Создан scripts/build-clusters.ts (k-means по реальным даташитам BSData,
 * K выбран по силуэту). Ручная типизация была кривой: в одной корзине
 * «infantry» жили и Battle Sisters (W1/Sv3+), и Acolyte Hybrids (W1/Sv5+),
 * и Bloodletters (W1/Sv7+), из-за чего медиана давала несуществующего юнита.
 *
 * НЕ ПРАВИТЬ ВРУЧНУЮ: перезапишется при следующей генерации.
 */

import type { ClusterProfile } from './clusterProfiles.ts';

export const CLUSTER_PROFILES: readonly ClusterProfile[] = [
${body}
];
`,
  'utf8'
);
console.log(`\nЗаписано ${profiles.length} типов → ${outPath} (${Date.now() - started} мс)`);
