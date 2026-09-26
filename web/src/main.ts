/**
 * Главный модуль веб-тирлиста.
 *
 * Отвечает за: фильтры (фракция, режим боя, тир, поиск), таблицу со всеми
 * показателями и панель деталей по юниту.
 *
 * Ничего не пересчитывается: все метрики, нормы, Total и тиры приходят готовыми
 * из web/public/data/tierlist.json, который собирает scripts/build-tierlist.ts.
 * Дублировать нормализацию на клиенте было смысл только ради редактора — по
 * правке одного юнита честный пересчёт всё равно давал бы другие числа, чем
 * серверная сборка, и два источника правды расходились бы между собой.
 */

import { ARCHETYPES } from '../../src/combat/archetypes.ts';
import { withinCalculationBudget } from '../../src/combat/budget.ts';
import {
  isTargetParadigm,
  type CombatMode,
  type TargetParadigm,
  type Tier,
  type TierlistData,
  type UnitEntry,
  type UnitMetrics,
  type UnitProfile,
} from './model.ts';

const DATA_URL = './data/tierlist.json';

const MODES: Array<{ id: CombatMode; title: string }> = [
  { id: 'ranged', title: 'Дальний бой' },
  { id: 'melee', title: 'Ближний бой' },
  { id: 'combined', title: 'Комбинированный' },
];

const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];

const state = {
  data: null as TierlistData | null,
  mode: 'combined' as CombatMode,
  targetParadigm: 'all' as TargetParadigm,
  faction: '',
  tierFilter: new Set<Tier>(),
  search: '',
  sortKey: 'totalScore',
  sortDesc: true,
  openUnit: null as UnitEntry | null,
  view: 'units' as 'units' | 'attached',
  attachedRows: [] as import('./model.ts').AttachedRow[],
};






/**
 * Метрики юнита в выбранной паре «парадигма × режим».
 *
 * Всё приходит из сборки, включая нормы, Total и тир, поэтому клиент ничего не
 * досчитывает. Запасной вариант — парадигма `all`: он есть в любой сборке, даже
 * если `metricsByParadigm` не собралась.
 */
function metricsOf(unit: UnitEntry): UnitMetrics {
  return (
    cellOf(unit, state.targetParadigm, state.mode) ??
    unit.metrics[state.mode] ??
    (unit.metricsByParadigm?.all?.[state.mode] as UnitMetrics)
  );
}

/** Отфильтрованные и отсортированные юниты для таблицы. */
function visibleUnits(): UnitEntry[] {
  if (!state.data) return [];
  if (state.view === 'attached') return [];
  const needle = state.search.trim().toLowerCase();
  const rows = state.data.units.filter((unit) => {
    if (state.view === 'attached') return false;
    if (!withinCalculationBudget(unit.points)) return false;
    if (state.faction && !unit.factions.includes(state.faction)) return false;
    if (state.tierFilter.size > 0 && !state.tierFilter.has(metricsOf(unit).tier)) {
      return false;
    }
    if (needle && !unit.name.toLowerCase().includes(needle)) return false;
    return true;
  });

  const key = state.sortKey;
  const dir = state.sortDesc ? -1 : 1;
  rows.sort((a, b) => {
    const left = cellValue(a, key);
    const right = cellValue(b, key);
    if (typeof left === 'string' || typeof right === 'string') {
      return String(left).localeCompare(String(right)) * dir || a.name.localeCompare(b.name);
    }
    return (left - right) * dir || a.name.localeCompare(b.name);
  });
  return rows;
}

function visibleAttachedRows(): import('./model.ts').AttachedRow[] {
  const needle = state.search.trim().toLowerCase();
  const rows = state.attachedRows.filter((row) => {
    if (state.faction && !row.factions.includes(state.faction)) return false;
    if (state.tierFilter.size > 0 && !state.tierFilter.has(row.tier)) return false;
    return needle === '' || row.name.toLowerCase().includes(needle);
  });
  const key = state.sortKey;
  const dir = state.sortDesc ? -1 : 1;
  rows.sort((a, b) => {
    if (key === 'name' || key === 'bestTargetName') {
      return String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * dir || a.name.localeCompare(b.name);
    }
    if (key === 'tier') {
      const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
      return ((order[a.tier] ?? 9) - (order[b.tier] ?? 9)) * dir || a.name.localeCompare(b.name);
    }
    return ((a[key as keyof typeof a] as number) - (b[key as keyof typeof b] as number)) * dir || a.name.localeCompare(b.name);
  });
  return rows;
}

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app === null) return;
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = (await response.json()) as TierlistData;
    state.attachedRows = state.data.attached?.[state.targetParadigm]?.[state.mode] ?? [];
    render(app);
  } catch (error) {
    app.innerHTML = `<div class="empty">Не удалось загрузить данные тирлиста.<br />${String(error)}<br />
      Соберите их командой: <code>npm run build:data</code></div>`;
  }
}

/** Форматирование чисел для таблицы. */
const num = (value: number, digits = 1): string => value.toFixed(digits);

/** Полоса значения 0–100 для наглядности в таблице. */
function bar(value: number): string {
  const width = Math.max(0, Math.min(100, value));
  return `<span class="bar"><i style="width:${width}%"></i></span>`;
}

/**
 * Названия типов целей берём из clusters.generated.ts: типы выведены из
 * данных, поэтому и подписи не должны быть захардкожены. Раньше здесь стоял
 * список из 13 имён, который рассыпался бы при любой смене K.
 */
const TARGET_LABELS: Record<string, string> = Object.fromEntries(
  ARCHETYPES.map((archetype) => [archetype.id, archetype.name])
);

const MODE_LABELS: Record<CombatMode, string> = {
  ranged: 'Дальний',
  melee: 'Ближний',
  combined: 'Обе фазы',
};

/** Подписи парадигм цели: те же, что у кнопок фильтра. */
const PARADIGM_LABELS: Record<string, string> = {
  all: 'Все цели',
  infantry: 'Пехота',
  elite: 'Элита',
  armor: 'Техника',
};

/**
 * Подписи групп входящего оружия для defenseVector.
 *
 * Ключи приходят из данных, поэтому подписи вынесены в одну карту: новой группе
 * без подписи строка в панели покажет голый ключ — это заметно и поправимо.
 */
const DEFENSE_GROUP_LABELS: Record<string, string> = {
  'small-arms': 'Стрелковое оружие',
  'heavy-infantry': 'Тяжёлая пехота',
  'melee-infantry': 'Пехота в ближнем бою',
  'monster-melee': 'Монстры в ближнем бою',
  'vehicle-guns': 'Орудия техники',
  'anti-armour': 'Антиброневое оружие',
  'mortal-precision': 'Точный огонь мортидами',
};

/** Колонки таблицы: ключ сортировки → заголовок и форматтер. */
const COLUMNS: Array<{ key: string; title: string; numeric: boolean; hint?: string }> = [
  { key: 'name', title: 'Юнит', numeric: false },
  { key: 'points', title: 'Очки', numeric: true, hint: 'Максимум 2000 для расчётов' },
  { key: 'models', title: 'Мод.', numeric: true },
  { key: 'rawMaxDamage', title: 'Уничт.очки/100', numeric: true, hint: 'Максимум уничтоженных очков цели на 100 очков юнита' },
  { key: 'bestTargetName', title: 'Лучшая цель', numeric: false },
  { key: 'universal', title: 'Среднее/100', numeric: true },
  { key: 'damagePer100', title: 'Урон/100', numeric: true },
  { key: 'absorbedPer100', title: 'Прочность/100', numeric: true, hint: 'Сколько урона противник обязан потратить, чтобы удалить юнит, на 100 его очков' },
  { key: 'utilityScore', title: 'Полезн.', numeric: true, hint: 'Utility, максимум 20' },
  {
    key: 'onceEffectDelta',
    title: 'Δ однораз.',
    numeric: true,
    hint: 'Дельта одноразовых способностей: насколько больше юнит уничтожил бы с одноразовым баффом. В TOTAL и норму урона НЕ входит — «once per battle» не действует постоянно',
  },
  { key: 'normDamage', title: 'Норм.урон', numeric: true },
  { key: 'normSurvivability', title: 'Норм.живуч.', numeric: true },
  { key: 'normUtility', title: 'Норм.пол.', numeric: true },
  { key: 'totalScore', title: 'TOTAL', numeric: true, hint: '0.55·норм.урон + 0.35·норм.живучесть + 0.10·норм.полезность' },
  { key: 'percentile', title: 'Перц.', numeric: true },
];

/** Значение ячейки таблицы. Всё берётся из собранных данных. */
function cellValue(unit: UnitEntry, key: string): string | number {
  const metrics = metricsOf(unit);
  switch (key) {
    case 'name':
      return unit.name;
    case 'points':
      return unit.points;
    case 'models':
      return unit.models;
    case 'unitType':
      return metrics.unitType === 'Melee' ? 'Ближний' : 'Дальний';
    case 'bestTargetName':
      return metrics.bestTargetName;
    case 'onceEffectDelta':
      // Дельта лежит на юните, а не в метриках: она справочная и не
      // пересчитывается на клиенте при правке характеристик — пересчитывать
      // её было бы некорректно, бафф одноразовый.
      return unit.onceEffectDelta ?? 0;
    default:
      return (metrics as unknown as Record<string, number>)[key] ?? 0;
  }
}

/** Отрисовка панели управления. */
function renderControls(): string {
  const factions = state.data?.factions ?? [];
  const modeButtons = MODES.map(
    (mode) =>
      `<button data-mode="${mode.id}" class="${state.mode === mode.id ? 'active' : ''}">${mode.title}</button>`
  ).join('');
  const paradigmButtons = (state.data?.paradigms ?? ['all', 'infantry', 'elite', 'armor']).map((paradigm) => {
    return `<button data-paradigm="${paradigm}" class="${state.targetParadigm === paradigm ? 'active' : ''}">${PARADIGM_LABELS[paradigm] ?? paradigm}</button>`;
  }).join('');
  const tierButtons = TIERS.map(
    (tier) =>
      `<button data-tier="${tier}" class="${state.tierFilter.has(tier) ? 'active' : ''}" title="Показать тир ${tier}">${tier}</button>`
  ).join('');

  return `
    <header>
      <h1>40K Tier List</h1>
      <p class="subtitle">
        Расчёт по правилам 11-й редакции. Клик по юниту открывает подробности:
        тир по всем видам боя, из чего сложились урон и живучесть, и разбор
        способностей. Все числа посчитаны при сборке тирлиста.
      </p>
      <div class="controls">
        <div class="control">
          <label>Раздел</label>
          <div class="modes">
            <button data-view="units" class="${state.view === 'units' ? 'active' : ''}">Юниты</button>
            <button data-view="attached" class="${state.view === 'attached' ? 'active' : ''}">С лидером</button>
          </div>
        </div>
        <div class="control">
          <label for="faction">Фракция</label>
          <select id="faction">
            <option value="">Все фракции</option>
            ${factions
              .map(
                (faction) =>
                  `<option value="${faction}" ${state.faction === faction ? 'selected' : ''}>${faction}</option>`
              )
              .join('')}
          </select>
        </div>
        <div class="control">
          <label>Режим боя</label>
          <div class="modes">${modeButtons}</div>
        </div>
        <div class="control">
          <label>Парадигма цели</label>
          <div class="modes">${paradigmButtons}</div>
        </div>
        <div class="control">
          <label>Тиры</label>
          <div class="tier-filter">${tierButtons}</div>
        </div>
        <div class="control">
          <label for="search">Поиск</label>
          <input id="search" type="search" placeholder="Название юнита" value="${state.search}" />
        </div>
        <div class="status" id="status"></div>
      </div>
    </header>`;
}


/** Отрисовка строк тирлиста. */
function renderTable(): string {
  const units = visibleUnits();
  if (units.length === 0) return '<div class="empty">Ничего не найдено</div>';

  const head = COLUMNS.map(
    (column) =>
      `<th class="${column.numeric ? 'num' : ''}" data-sort="${column.key}" ${column.hint ? `title="${column.hint}"` : ''}>
        ${column.title}${state.sortKey === column.key ? (state.sortDesc ? ' ↓' : ' ↑') : ''}
      </th>`
  ).join('');

  const rows = units
    .map((unit) => {
      const metrics = metricsOf(unit);
      const cells = COLUMNS.filter((column) => column.key !== 'name').map((column) => {
        const value = cellValue(unit, column.key);
        const numeric = column.numeric;
        let text = typeof value === 'number' ? num(value) : value;
        // В колонках нормировки показываем полосу: нагляднее, чем сухое число.
        if (column.key === 'normDamage' || column.key === 'normSurvivability' || column.key === 'normUtility') {
          text = `${bar(Number(value))} ${num(Number(value))}`;
        }
        return `<td class="${numeric ? 'num' : ''}">${text}</td>`;
      }).join('');

      const tier = metrics.tier;
      return `<tr>
        <td>
          <span class="tier-badge" data-tier="${tier}">${tier}</span>
          <span class="unit-name" data-open="${unit.id}">${unit.name}</span>
          ${
            unit.sensitivity?.high
              ? `<span class="tag sens-mark" title="Тир меняется в ${(unit.sensitivity.tierChangeProbability * 100).toFixed(0)}% сценариев возмущения (±15% и ±30% числа моделей в эталонных целях) — оценка держится на узком матчапе">Sensitivity: HIGH</span>`
              : unit.sensitivity?.medium
                ? `<span class="tag sens-mark" title="Тир меняется в ${(unit.sensitivity.tierChangeProbability * 100).toFixed(0)}% сценариев возмущения (±15% и ±30% числа моделей в эталонных целях)">Sensitivity: MEDIUM</span>`
                : ''
          }
        </td>
        ${cells}
      </tr>`;
    })
    .join('');

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Сводка по тирам для строки состояния. */
function renderStatus(): string {
  const attached = state.view === 'attached';
  const units = attached ? visibleAttachedRows() : visibleUnits();
  const counts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const unit of units) {
    const tier = attached
      ? (unit as import('./model.ts').AttachedRow).tier
      : metricsOf(unit as UnitEntry).tier;
    if (tier) counts[tier] += 1;
  }
  const parts = TIERS.map((tier) => `${tier}:${counts[tier]}`).join('  ');
  const section = attached ? 'Отряды с лидерами' : 'Юниты';
  return `${section} · ${MODE_LABELS[state.mode]} · ${parts} · всего ${units.length}`;
}



/** Человекочитаемый профиль оружия для карточки. */
function weaponProfileText(weapon: UnitProfile['models'][number]['weapons'][number]): string {
  const dice = (spec: { count: number; sides: number; plus: number } | null): string => {
    if (spec === null) return '-';
    if (spec.sides === 1) return String(spec.count + spec.plus);
    return `${spec.count}D${spec.sides}${spec.plus !== 0 ? spec.plus > 0 ? `+${spec.plus}` : spec.plus : ''}`;
  };
  const parts = [
    weapon.kind === 'ranged' && weapon.range !== null ? `${weapon.range}"` : 'Melee',
    dice(weapon.attacks),
    weapon.skill === null ? '-' : `${weapon.skill}+`,
    weapon.strength === null ? '-' : `S${weapon.strength}`,
    `AP${weapon.ap}`,
    dice(weapon.damage),
  ];
  return parts.join(' · ');
}




/**
 * Экранирование текста из BSData.
 *
 * Способности и названия приходят из данных и содержат кавычки и апострофы,
 * которые без экранирования ломают атрибуты (особенно title=).
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Метрики юнита в произвольной комбинации «парадигма × режим».
 *
 * Ключи приходят из данных (`paradigms` может измениться), поэтому проверяем
 * принадлежность к типу: иначе типизация Record ломается на индексации строкой.
 */
function cellOf(
  unit: UnitEntry,
  paradigm: string,
  mode: CombatMode
): UnitMetrics | null {
  if (!isKnownParadigm(paradigm)) return null;
  return unit.metricsByParadigm?.[paradigm]?.[mode] ?? null;
}

/** Отсекает значения, которых нет в типе: внешние ключи из JSON. */
function isKnownParadigm(value: string): value is TargetParadigm {
  return isTargetParadigm(value, state.data?.paradigms ?? PARADIGM_FALLBACK);
}

/** Парадигмы по умолчанию, если данные ещё не загружены. */
const PARADIGM_FALLBACK: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

/**
 * Матрица тиров по всем 12 комбинациям.
 *
 * Раньше в панели был только выбранный вид, и было не видно, является ли низкий
 * тир свойством юнита или следствием выбранной парадигмы цели. Матрица показывает
 * это прямо: если юнит S против пехоты и D против техники, виновата парадигма.
 */
function renderParadigmMatrix(unit: UnitEntry): string {
  const paradigms = state.data?.paradigms ?? ['all'];
  const modes = state.data?.modes ?? ['combined'];
  const head = modes.map((mode) => `<th class="num">${MODE_LABELS[mode]}</th>`).join('');
  const body = paradigms
    .map((paradigm) => {
      const cells = modes
        .map((mode) => {
          const cell = cellOf(unit, paradigm, mode);
          if (cell === null) return '<td class="num">—</td>';
          const current = paradigm === state.targetParadigm && mode === state.mode;
          return `<td class="num${current ? ' current' : ''}">
            <span class="tier-badge" data-tier="${cell.tier}">${cell.tier}</span>
            <span class="cell-total">${num(cell.totalScore, 1)}</span>
          </td>`;
        })
        .join('');
      return `<tr><th>${PARADIGM_LABELS[paradigm] ?? paradigm}</th>${cells}</tr>`;
    })
    .join('');
  return `<section>
      <h3>Тир по всем видам боя</h3>
      <p class="hint">Все 12 комбинаций «парадигма цели × режим». Подсвечена та, что выбрана в фильтрах.</p>
      <div class="table-wrap"><table class="matrix">
        <thead><tr><th>Парадигма цели</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </section>`;
}

/**
 * Разбивка боя: сколько очков цели юнит уничтожает по каждому типу цели и
 * сколько живёт против каждой группы входящего оружия.
 *
 * Полосы нормированы на максимум по юниту, поэтому читается именно профиль
 * «против кого он силён», а не абсолютные числа.
 */
function renderBreakdowns(unit: UnitEntry): string {
  const metrics = metricsOf(unit);
  const destroyed = metrics.destroyedPointsByTarget ?? {};
  const offenseMax = Math.max(1, ...Object.values(destroyed));
  const offense = Object.entries(destroyed)
    .map(
      ([id, value]) => `<div class="breakdown-row">
        <span class="bk">${esc(TARGET_LABELS[id] ?? id)}</span>
        <span class="bar"><i style="width:${(value / offenseMax) * 100}%"></i></span>
        <span class="bv">${num(value, 1)}</span>
      </div>`
    )
    .join('');

  const defense = metrics.defenseVector ?? {};
  const defenseMax = Math.max(1, ...Object.values(defense));
  const defenseRows = Object.entries(defense)
    .map(
      ([group, value]) => `<div class="breakdown-row">
        <span class="bk">${esc(DEFENSE_GROUP_LABELS[group] ?? group)}</span>
        <span class="bar"><i style="width:${(value / defenseMax) * 100}%"></i></span>
        <span class="bv">${num(value, 2)}</span>
      </div>`
    )
    .join('');

  return `<section>
      <h3>Урон по типам целей</h3>
      <p class="hint">Уничтоженные очки на 100 очков юнита. Лучшая цель: ${esc(metrics.bestTargetName || '—')}.</p>
      ${offense || '<p class="hint">Нет данных.</p>'}
    </section>
    <section>
      <h3>Живучесть по группам входящего оружия</h3>
      <p class="hint">Сколько боевых фаз юнит доживает против каждой группы.</p>
      ${defenseRows || '<p class="hint">Нет данных.</p>'}
    </section>`;
}

/**
 * Ручные способности, разложенные по категориям.
 *
 * Категории важны не для красоты: в Total входят только стратегические, поэтому
 * без разбивки не видно, почему, например, FNP или Sororitas_Retributors не
 * подняли оценку — а это почти всегда вопрос, который и задают, глядя на юнита.
 */
function renderUtilityDetails(unit: UnitEntry): string {
  const flags = unit.utilityFlags ?? [];
  if (flags.length === 0) {
    return '<section><h3>Небоевая полезность: 0 / 20</h3><p class="hint">Ни одной распознанной способности.</p></section>';
  }
  const known = ['strategic', 'archetype', 'modeled'];
  const groups: Array<[string, string, string]> = [
    ['strategic', 'Стратегические', 'Входят в Total и определяют тир'],
    ['archetype', 'Архетипные', 'Справочные: показывают, к чему юнит тяготеет'],
    ['modeled', 'Учтённые в бою', 'Уже сидят в симуляции, поэтому в Total не входят'],
    ['other', 'Прочие', 'Категория не распознана — скорее всего, новый вид эффекта'],
  ];
  const body = groups
    .map(([id, title, note]) => {
      const items = flags.filter((flag) =>
        id === 'other' ? !known.includes(flag.category) : flag.category === id
      );
      if (items.length === 0) return '';
      const chips = items
        .map(
          (flag) =>
            `<span class="flag" title="${esc(flag.reason)}"><b>${esc(flag.id)}</b> +${flag.points} — ${esc(flag.reason)}</span>`
        )
        .join('');
      return `<div class="util-group">
          <h4>${title} <span class="muted">· ${note}</span></h4>
          <div class="flags">${chips}</div>
        </div>`;
    })
    .join('');
  return `<section>
      <h3>Небоевая полезность: ${unit.utilityScore} / 20</h3>
      <p class="hint">Сумма стратегических очков. Только они входят в Total.</p>
      ${body}
    </section>`;
}

/** Устойчивость тира к произвольным допущениям модели. */
function renderSensitivityDetails(unit: UnitEntry): string {
  const sensitivity = unit.sensitivity;
  if (sensitivity === undefined) {
    return '<section><h3>Чувствительность тира</h3><p class="hint">Нет данных: сборка шла с --skip-sensitivity.</p></section>';
  }
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
  const verdict = sensitivity.high ? 'HIGH' : sensitivity.medium ? 'MEDIUM' : 'устойчив';
  return `<section>
      <h3>Чувствительность тира: ${verdict}</h3>
      <p class="hint">Тир пересчитывается при ±15% и ±30% числа моделей в эталонных целях.</p>
      <div class="metrics">
        <div class="metric"><div class="k">Смена тира</div><div class="v">${percent(sensitivity.tierChangeProbability)}</div></div>
        <div class="metric"><div class="k">Разброс перцентиля</div><div class="v">${num(sensitivity.spread, 1)}</div></div>
      </div>
    </section>`;
}

/**
 * Дельта одноразовых способностей.
 *
 * Отдельная справочная величина: она показывает, насколько юнит прибавил бы с
 * одноразовым баффом, но в Total, норму урона и тир не входит — «once per
 * battle» не действует постоянно. Поэтому здесь ноль это норма, а не ошибка.
 */
function renderOnceEffectDetails(unit: UnitEntry): string {
  const delta = unit.onceEffectDelta ?? 0;
  return `<section>
      <h3>Одноразовые способности</h3>
      <div class="metrics">
        <div class="metric"><div class="k">Δ уничтоженных очков</div><div class="v">${num(delta, 2)}</div></div>
      </div>
      <p class="hint">Справочно. В Total и норму урона не входит: способность срабатывает один раз за бой, а не постоянно.</p>
    </section>`;
}

/**
 * Варианты снаряжения.
 *
 * Метрики для loadout'ов в JSON намеренно нет (считать их для тысяч юнитов
 * дорого), поэтому показываются очки и состав оружия, а не выдуманные нули.
 */
function renderLoadoutDetails(unit: UnitEntry): string {
  const loadouts = unit.loadouts ?? [];
  if (loadouts.length === 0) {
    return '<section><h3>Loadout-варианты</h3><p class="hint">Для этого юнита нет отдельных вариантов снаряжения.</p></section>';
  }
  const body = loadouts
    .map((loadout) => {
      const weapons = loadout.unit?.models?.[0]?.weapons ?? [];
      const list = weapons.length === 0 ? '—' : weapons.map((weapon) => esc(weapon.name)).join(', ');
      return `<div class="weapon-card">
        <div class="whead">
          <span class="name">${esc(loadout.name)}</span>
          <span class="profile">${loadout.points} очков</span>
        </div>
        <div class="profile">${list}</div>
      </div>`;
    })
    .join('');
  return `<section><h3>Loadout-варианты</h3>${body}</section>`;
}

/** Варианты «юнит + лидер» для выбранных вида боя и парадигмы. */
function renderLeaderDetails(unit: UnitEntry): string {
  const attached = state.data?.attached?.[state.targetParadigm]?.[state.mode] ?? [];
  const rows = attached.filter((row) => row.unitId === unit.id);
  if (rows.length === 0) {
    return '<section><h3>С лидерами</h3><p class="hint">Для этого юнита в выбранном виде нет разрешённых лидеров.</p></section>';
  }
  const leaderName = (id: string | null): string =>
    id === null ? '—' : (state.data?.leaders.find((leader) => leader.id === id)?.name ?? id);
  const body = rows
    .map(
      (row) => `<tr>
      <td>${esc(row.name)}</td>
      <td>${esc(leaderName(row.leaderId))}</td>
      <td class="num">${row.points}</td>
      <td class="num">${num(row.rawMaxDamage, 1)}</td>
      <td>${esc(row.bestTargetName)}</td>
      <td class="num">${num(row.totalScore, 1)}</td>
      <td><span class="tier-badge" data-tier="${row.tier}">${row.tier}</span></td>
    </tr>`
    )
    .join('');
  return `<section>
      <h3>С лидерами — ${PARADIGM_LABELS[state.targetParadigm]}, ${MODE_LABELS[state.mode].toLowerCase()}</h3>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Отряд</th><th>Лидер</th><th class="num">Очки</th>
          <th class="num">Уничт. очки/100</th><th>Лучшая цель</th>
          <th class="num">TOTAL</th><th>Тир</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </section>`;
}

/**
 * Панель деталей по юниту: только чтение, все числа берутся из сборки.
 *
 * Порядок секций — от «что это за юнит» к «почему такой тир»: сначала итог по
 * выбранному виду, затем как он меняется по парадигмам, затем из чего сложились
 * урон и живучесть, и только потом справочные величины.
 */
function renderDetails(unit: UnitEntry): string {
  const metrics = metricsOf(unit);
  const paradigm = PARADIGM_LABELS[state.targetParadigm] ?? state.targetParadigm;
  const mode = MODE_LABELS[state.mode].toLowerCase();

  const summary = `<section>
      <h3>Показатели — ${paradigm.toLowerCase()}, ${mode}</h3>
      <div class="metrics">
        <div class="metric"><div class="k">Тир</div><div class="v">${metrics.tier}</div></div>
        <div class="metric"><div class="k">Total</div><div class="v">${num(metrics.totalScore)}</div></div>
        <div class="metric"><div class="k">Перцентиль</div><div class="v">${num(metrics.percentile)}</div></div>
        <div class="metric"><div class="k">Урон/100</div><div class="v">${num(metrics.effectiveDamage, 2)}</div></div>
        <div class="metric" title="Сколько боевых фаз юнит доживает — это и есть выживаемость в тире"><div class="k">Живучесть, фазы</div><div class="v">${num(metrics.effectiveSurvivability, 2)}<small title="Нормализованная прочность среди юнитов своей цены">${num(metrics.normSurvivability, 0)}</small></div></div>
        <div class="metric" title="Поглощённый до смерти урон — диагностика, в тир не входит"><div class="k">Прочность/100</div><div class="v">${num(metrics.absorbedPer100, 2)}</div></div>
        <div class="metric" title="Запас ран на 100 очков — диагностика, не метрика выживаемости"><div class="k">Ран/100</div><div class="v">${num(metrics.bulkPer100, 2)}</div></div>
        <div class="metric"><div class="k">Норм. урон</div><div class="v">${num(metrics.normDamage)}</div></div>
        <div class="metric"><div class="k">Норм. полезн.</div><div class="v">${num(metrics.normUtility)}</div></div>
      </div>
      <p class="hint">Total = 0.55·норм.урон + 0.35·норм.живучесть + 0.10·норм.полезность.</p>
    </section>`;

  return [
    summary,
    renderParadigmMatrix(unit),
    renderBreakdowns(unit),
    renderOnceEffectDetails(unit),
    renderUtilityDetails(unit),
    renderSensitivityDetails(unit),
    renderLoadoutDetails(unit),
    renderLeaderDetails(unit),
    renderWeapons(unit),
  ].join('');
}

/** Оружие юнита: состав и профили, без полей правки. */
function renderWeapons(unit: UnitEntry): string {
  const profile = unit.unit;
  const model = profile?.models?.[0];
  if (model === undefined) return '';
  const onlyKind = state.mode === 'ranged' ? 'ranged' : state.mode === 'melee' ? 'melee' : 'both';
  const weapons = model.weapons.filter((weapon) => onlyKind === 'both' || weapon.kind === onlyKind);
  const cards = weapons
    .map(
      (weapon) => `<div class="weapon-card">
      <div class="whead">
        <span class="name">${esc(weapon.name)}</span>
        <span class="profile">${weaponProfileText(weapon)}</span>
      </div>
      ${weapon.keywords.length > 0 ? `<div class="weapon-keywords">${weapon.keywords.map((keyword) => `<span class="weapon-keyword" title="${esc(keyword.name)}">${esc(keyword.raw)}</span>`).join('')}</div>` : ''}
    </div>`
    )
    .join('');
  return `<section>
      <h3>Оружие${onlyKind === 'both' ? '' : ` — ${MODE_LABELS[state.mode].toLowerCase()}`}</h3>
      ${cards || '<p class="hint">В выбранном режиме у юнита нет оружия.</p>'}
    </section>`;
}

/** Модальное окно с подробностями по юниту. */
function renderUnitDialog(unit: UnitEntry): string {
  return `<div class="editor-backdrop" id="details-backdrop">
    <div class="editor">
      <h2>${esc(unit.name)}</h2>
      <p class="hint">${esc(unit.faction)} · ${unit.points} очков · ${unit.models} моделей · ${esc(unit.archetype)}</p>
      ${renderDetails(unit)}
      <div class="editor-actions">
        <button data-action="close">Закрыть</button>
      </div>
    </div>
  </div>`;
}




/** Таблица юнитов с присоединёнными лидерами. */
function renderAttachedTable(): string {
  const rows = visibleAttachedRows();
  if (rows.length === 0) return '<div class="empty">Нет подходящих сочетаний «отряд + лидер».</div>';
  const head = [
    ['name', 'Отряд + лидер'],
    ['points', 'Очки'],
    ['models', 'Мод.'],
    ['rawMaxDamage', 'Уничт. очки/100'],
    ['bestTargetName', 'Лучшая цель'],
    ['effectiveSurvivability', 'Живучесть'],
    ['utilityScore', 'Полезность'],
    ['totalScore', 'TOTAL'],
    ['tier', 'Тир'],
  ].map(([key, title]) => {
    const numeric = ['points', 'models', 'rawMaxDamage', 'effectiveSurvivability', 'utilityScore', 'totalScore'].includes(key);
    return `<th class="${numeric ? 'num' : ''}" data-sort="${key}">${title}${state.sortKey === key ? (state.sortDesc ? ' ↓' : ' ↑') : ''}</th>`;
  }).join('');
  const body = rows.map((row) => `<tr>
    <td><span class="tier-badge" data-tier="${row.tier}">${row.tier}</span><span class="unit-name">${row.name}</span></td>
    <td class="num">${row.points}</td>
    <td class="num">${row.models}</td>
    <td class="num">${num(row.rawMaxDamage, 1)}</td>
    <td>${row.bestTargetName}</td>
    <td class="num">${num(row.effectiveSurvivability, 1)}</td>
    <td class="num">${row.utilityScore}</td>
    <td class="num">${num(row.totalScore, 1)}</td>
    <td><span class="tier-badge" data-tier="${row.tier}">${row.tier}</span></td>
  </tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Главная функция отрисовки: фильтры + таблица + окно деталей. */
function render(app: HTMLElement): void {
  const dialog = state.openUnit === null ? '' : renderUnitDialog(state.openUnit);
  app.innerHTML = `${renderControls()}${state.view === 'attached' ? renderAttachedTable() : renderTable()}${dialog}`;
  const status = document.querySelector<HTMLDivElement>('#status');
  if (status !== null) status.textContent = renderStatus();
}

/** Навешивает обработчики на элементы, созданные render(). */
function bindEvents(app: HTMLElement): void {
  app.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    const viewButton = target.closest<HTMLElement>('[data-view]');
    if (viewButton?.dataset.view) {
      state.view = viewButton.dataset.view as 'units' | 'attached';
      render(app);
      return;
    }

    const modeButton = target.closest<HTMLElement>('[data-mode]');
    if (modeButton?.dataset.mode) {
      state.mode = modeButton.dataset.mode as CombatMode;
      state.attachedRows = state.data?.attached?.[state.targetParadigm]?.[state.mode] ?? [];
      render(app);
      return;
    }

    const paradigmButton = target.closest<HTMLElement>('[data-paradigm]');
    if (paradigmButton?.dataset.paradigm) {
      state.targetParadigm = paradigmButton.dataset.paradigm as TargetParadigm;
      state.attachedRows = state.data?.attached?.[state.targetParadigm]?.[state.mode] ?? [];
      render(app);
      return;
    }

    const tierButton = target.closest<HTMLElement>('.tier-filter [data-tier]');
    if (tierButton?.dataset.tier) {
      const tier = tierButton.dataset.tier as Tier;
      if (state.tierFilter.has(tier)) state.tierFilter.delete(tier);
      else state.tierFilter.add(tier);
      render(app);
      return;
    }

    const sortHeader = target.closest<HTMLElement>('th[data-sort]');
    if (sortHeader?.dataset.sort) {
      const key = sortHeader.dataset.sort;
      if (state.sortKey === key) state.sortDesc = !state.sortDesc;
      else {
        state.sortKey = key;
        state.sortDesc = true;
      }
      render(app);
      return;
    }

    const openLink = target.closest<HTMLElement>('[data-open]');
    if (openLink?.dataset.open && state.data) {
      const unit = state.data.units.find((candidate) => candidate.id === openLink.dataset.open);
      if (unit !== undefined) {
        state.openUnit = unit;
        render(app);
        return;
      }
    }

    if (target.closest<HTMLElement>('[data-action="close"]') !== null) {
      state.openUnit = null;
      render(app);
      return;
    }

    // Клик по фону окна закрывает его.
    if (target.id === 'details-backdrop') {
      state.openUnit = null;
      render(app);
    }
  });

  app.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.id === 'faction') {
      state.faction = target.value;
      render(app);
    }
  });

  app.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'search') {
      state.search = target.value;
      render(app);
      // Возвращаем фокус в поиск: перерисовка сбрасывает его.
      const search = document.querySelector<HTMLInputElement>('#search');
      if (search !== null) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }
  });
}

const app = document.querySelector<HTMLDivElement>('#app');
if (app !== null) {
  bindEvents(app);
  void boot();
}

