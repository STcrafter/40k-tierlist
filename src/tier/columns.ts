/**
 * Колонки тирлиста и состав индекса — одно место на обоих концах.
 *
 * Связь между ними неочевидна и раньше молча ломалась: таблица читает поля из
 * `cells` в JSON, а собиратель решает, что туда положить. Забытое поле не
 * вызывало ошибки — колонка просто показывала нули, и это выглядело как
 * «юнит ничего не умеет». Теперь список колонок и список полей индекса лежат
 * рядом, а тест сверяет их.
 *
 * Модуль без зависимостей, чтобы его могли импортировать и сборщик под Node,
 * и клиент в браузере.
 */

/**
 * Ключи сортировки, которые берутся не из метрик, а из полей юнита.
 */
export const UNIT_LEVEL_COLUMN_KEYS = [
  'name',
  'points',
  'models',
  'bestTargetName',
  'onceDamage',
  'onceSurvivability',
] as const;

/**
 * Поля метрики, нужные строке таблицы, но не являющиеся колонками сортировки.
 *
 * `tier` рисуется пластиной в каждой строке, `bestTarget` — подписью цели в
 * панели деталей. Без них строка осталась бы без ранга, а колонка сортировки
 * по тиру работала бы вслепую.
 */
export const ROW_ONLY_CELL_KEYS = ['tier', 'bestTarget'] as const;

/**
 * Поля метрики, попадающие в `cells` индекса.
 *
 * Прореживание сделано по COLUMNS: в таблице видны ровно эти величины, а
 * остальное (векторы по кластерам `destroyedPointsByTarget`,
 * `effectiveOffenseVector`, `defenseVector`, налоги, диагностика) нужно только
 * открытой панели деталей и только для одного юнита за раз.
 *
 * Именно векторы и были основным весом: 12 ячеек × 24 поля на 1093 юнита давали
 * 16.6 МБ, тогда как таблица использует меньше половины полей в них.
 */
export const INDEX_CELL_KEYS = [
  // Итог и ранг
  'tier',
  'totalScore',
  'percentile',
  // Урон
  'rawMaxDamage',
  'universal',
  'damagePer100',
  // Живучесть
  'absorbedPer100',
  // Полезность
  'utilityScore',
  // Нормы, из которых считается Total
  'normDamage',
  'normSurvivability',
  'normUtility',
  // Подпись лучшей цели
  'bestTarget',
  'bestTargetName',
] as const;

/**
 * Колонки таблицы: ключ сортировки → заголовок и формат.
 *
 * `hint` — текст подсказки на заголовке. Он объясняет, что именно в колонке,
 * потому что половина названий («Прочность/100», «Ран/100») без пояснения
 * читается как две разные меры одного и того же.
 */
export const COLUMNS: ReadonlyArray<{
  key: string;
  title: string;
  numeric: boolean;
  hint?: string;
}> = [
  { key: 'name', title: 'Юнит', numeric: false },
  { key: 'points', title: 'Очки', numeric: true, hint: 'Максимум 2000 для расчётов' },
  { key: 'models', title: 'Мод.', numeric: true },
  {
    key: 'rawMaxDamage',
    title: 'Уничт.очки/100',
    numeric: true,
    hint: 'Максимум уничтоженных очков цели на 100 очков юнита',
  },
  { key: 'bestTargetName', title: 'Лучшая цель', numeric: false },
  { key: 'universal', title: 'Среднее/100', numeric: true },
  { key: 'damagePer100', title: 'Урон/100', numeric: true },
  {
    key: 'absorbedPer100',
    title: 'Прочность/100',
    numeric: true,
    hint: 'Сколько урона противник обязан потратить, чтобы удалить юнит, на 100 его очков',
  },
  { key: 'utilityScore', title: 'Полезн.', numeric: true, hint: 'Utility, максимум 20' },
  {
    key: 'onceDamage',
    title: 'Δ 1-раз урон',
    numeric: true,
    hint: 'Дельта одноразовых БОЕВЫХ способностей: насколько больше юнит уничтожил бы с одноразовым баффом. В TOTAL и нормы НЕ входит — «once per battle» не действует постоянно',
  },
  {
    key: 'onceSurvivability',
    title: 'Δ 1-раз жив.',
    numeric: true,
    hint: 'Дельта одноразовых ЗАЩИТНЫХ способностей: насколько больше боевых фаз юнит прожил бы. Справочно, в тир не входит',
  },
  { key: 'normDamage', title: 'Норм.урон', numeric: true },
  { key: 'normSurvivability', title: 'Норм.живуч.', numeric: true },
  { key: 'normUtility', title: 'Норм.пол.', numeric: true },
  {
    key: 'totalScore',
    title: 'TOTAL',
    numeric: true,
    hint: '0.55·норм.урон + 0.35·норм.живучесть + 0.10·норм.полезность',
  },
  { key: 'percentile', title: 'Перц.', numeric: true },
];

/**
 * Ключи колонок, которые обязаны присутствовать в индексе.
 *
 * Именно на этом равенстве держится таблица: остальное она читает с юнита.
 */
export const INDEXED_COLUMN_KEYS: ReadonlySet<string> = new Set(
  COLUMNS.map((column) => column.key).filter(
    (key) => !(UNIT_LEVEL_COLUMN_KEYS as readonly string[]).includes(key)
  )
);
