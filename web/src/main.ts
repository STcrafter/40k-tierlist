/**
 * Главный модуль веб-тирлиста.
 *
 * Отвечает за: фильтры (фракция, режим боя, тир, поиск), таблицу и панель
 * деталей по юниту. Ничего не пересчитывает — все метрики, нормы, Total и тиры
 * приходят готовыми из сборки `scripts/build-tierlist.ts`.
 *
 * ЗАГРУЗКА ДАННЫХ. Раньше был один файл на 36 МБ: он грузился целиком перед
 * первой отрисовкой и разбирался в памяти на несколько секунд, из которых
 * таблица показывала меньше процента. Сейчас сборка отдаёт три среза:
 *
 *   data/tierlist.json      индекс — только то, что рисует таблица; грузится сразу
 *   data/attached.json      строки «юнит + лидер»; грузится при переключении вкладки
 *   data/units/<id>.json    полная запись юнита; грузится по клику, кэшируется
 *
 * ОТРИСОВКА. Каркас строится один раз, дальше перерисовываются только изменившиеся
 * части. Раньше на каждый символ поиска `app.innerHTML` пересобирался целиком,
 * а фокус в поле возвращался костылём через `document.querySelector('#search')`
 * — потому что элемент каждый раз был новым. Теперь поле живёт в каркасе.
 */

import { ARCHETYPES } from '../../src/combat/archetypes.ts';
import { withinCalculationBudget } from '../../src/combat/budget.ts';
import { COLUMNS } from '../../src/tier/columns.ts';
import {
  isTargetParadigm,
  type AttachedData,
  type AttachedRow,
  type CombatMode,
  type IndexData,
  type TargetParadigm,
  type Tier,
  type UnitCell,
  type UnitDetail,
  type UnitIndexEntry,
  type UnitMetrics,
  type UnitProfile,
} from './model.ts';

const INDEX_URL = './data/tierlist.json';
const ATTACHED_URL = './data/attached.json';
const UNIT_URL = (id: string): string => `./data/units/${encodeURIComponent(id)}.json`;

const MODES: Array<{ id: CombatMode; title: string }> = [
  { id: 'ranged', title: 'Дальний бой' },
  { id: 'melee', title: 'Ближний бой' },
  { id: 'combined', title: 'Комбинированный' },
];

const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];

/** Парадигмы по умолчанию, если индекс ещё не загружен. */
const PARADIGM_FALLBACK: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

/** Задержка перед перерисовкой по вводу в поиск. */
const SEARCH_DEBOUNCE_MS = 140;

const state = {
  index: null as IndexData | null,
  attached: null as AttachedData | null,
  mode: 'combined' as CombatMode,
  targetParadigm: 'all' as TargetParadigm,
  faction: '',
  tierFilter: new Set<Tier>(),
  search: '',
  sortKey: 'totalScore',
  sortDesc: true,
  view: 'units' as 'units' | 'attached',
  /** Открытая панель деталей: id юнита, сама запись и статус загрузки. */
  open: null as { id: string; detail: UnitDetail | null; error: string | null } | null,
};

/**
 * Кэш полных записей юнитов.
 *
 * Запись не меняется в рамках сессии, а открыть одного и того же юнита можно
 * много раз: повторная загрузка была бы и лишним трафиком, и миганием панели.
 */
const detailCache = new Map<string, UnitDetail>();

/**
 * Загрузка строк «с лидерами», один раз за сессию.
 *
 * Кэшируется промис, а не результат: пока файл едет, вкладку можно
 * переключить туда-обратно, и без этого каждый раз пошёл бы новый запрос на
 * одни и те же 6.7 МБ.
 */
let attachedPromise: Promise<AttachedData> | null = null;

/** Индекс — единственный файл, без которого таблица не рисуется. */
async function loadIndex(): Promise<IndexData> {
  const response = await fetch(INDEX_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as IndexData;
}

/** Полная запись юнита; при повторном открытии берётся из кэша. */
async function loadDetail(id: string): Promise<UnitDetail> {
  const cached = detailCache.get(id);
  if (cached !== undefined) return cached;
  const response = await fetch(UNIT_URL(id));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const detail = (await response.json()) as UnitDetail;
  detailCache.set(id, detail);
  return detail;
}

function loadAttached(): Promise<AttachedData> {
  attachedPromise ??= (async () => {
    const response = await fetch(ATTACHED_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as AttachedData;
  })();
  return attachedPromise;
}

/* ─────────────────────────  Подписи и формат  ───────────────────────── */

/** Форматирование чисел для таблицы. */
const num = (value: number, digits = 1): string => value.toFixed(digits);

/** Полоса значения 0–100 для наглядности в таблице. */
function bar(value: number): string {
  const width = Math.max(0, Math.min(100, value));
  return `<span class="bar"><i style="width:${width}%"></i></span>`;
}

/**
 * Названия типов целей берём из ARCHETYPES: типы выведены из данных, поэтому и
 * подписи не должны быть захардкожены. Раньше здесь стоял список из 13 имён,
 * который рассыпался бы при любой смене K.
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

/*
 * Колонки таблицы приходят из src/tier/columns.ts — оттуда же сборщик берёт
 * состав индекса. Две копии списка разошлись бы при первой же правке, и
 * колонка тихо показала бы нули вместо данных; сверку делает columns.test.ts.
 */

/** Колонки, где показывается полоса: сухое число читается хуже. */
const BAR_COLUMNS = new Set(['normDamage', 'normSurvivability', 'normUtility']);

/** Отсекает значения, которых нет в типе: внешние ключи из JSON. */
function isKnownParadigm(value: string): value is TargetParadigm {
  return isTargetParadigm(value, state.index?.paradigms ?? PARADIGM_FALLBACK);
}

/**
 * Ячейка юнита в выбранной паре «парадигма × режим».
 *
 * Данных достаточно: и тир, и нормы приезжают посчитанными. Фолбэк на `all`
 * нужен на случай, если сборка отдала индекс без этой парадигмы.
 */
function cellOf(unit: UnitIndexEntry, paradigm: string, mode: CombatMode): UnitCell | null {
  if (!isKnownParadigm(paradigm)) return null;
  return unit.cells?.[paradigm]?.[mode] ?? unit.cells?.all?.[mode] ?? null;
}

/** Значение ячейки таблицы. Всё берётся из собранных данных. */
function cellValue(unit: UnitIndexEntry, key: string): string | number {
  const cell = cellOf(unit, state.targetParadigm, state.mode);
  switch (key) {
    case 'name':
      return unit.name;
    case 'points':
      return unit.points;
    case 'models':
      return unit.models;
    case 'bestTargetName':
      return cell?.bestTargetName ?? '—';
    case 'onceDamage':
      // Дельты лежат на юните, а не в метриках: они справочные и не
      // пересчитываются на клиенте — пересчитывать их было бы некорректно,
      // бафф одноразовый.
      return unit.onceEffectDeltas?.damage ?? 0;
    case 'onceSurvivability':
      return unit.onceEffectDeltas?.survivability ?? 0;
    default:
      return ((cell ?? {}) as unknown as Record<string, number>)[key] ?? 0;
  }
}

/** Порядок тиров для сортировки: S выше D, а не по алфавиту. */
const TIER_ORDER: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };

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

/* ─────────────────────────  Данные для таблицы  ───────────────────────── */

/** Отфильтрованные и отсортированные юниты. */
function visibleUnits(): UnitIndexEntry[] {
  const index = state.index;
  if (index === null || state.view === 'attached') return [];
  const needle = state.search.trim().toLowerCase();
  const rows = index.units.filter((unit) => {
    if (!withinCalculationBudget(unit.points)) return false;
    if (state.faction && !unit.factions.includes(state.faction)) return false;
    if (needle && !unit.name.toLowerCase().includes(needle)) return false;
    const tier = cellOf(unit, state.targetParadigm, state.mode)?.tier;
    if (state.tierFilter.size > 0 && (tier === undefined || !state.tierFilter.has(tier))) {
      return false;
    }
    return true;
  });
  const dir = state.sortDesc ? -1 : 1;
  return rows.sort((a, b) => compareUnits(a, b, state.sortKey) * dir);
}

function visibleAttachedRows(): AttachedRow[] {
  if (state.attached === null) return [];
  const needle = state.search.trim().toLowerCase();
  const rows = (state.attached.attached?.[state.targetParadigm]?.[state.mode] ?? []).filter((row) => {
    if (state.faction && !row.factions.includes(state.faction)) return false;
    if (state.tierFilter.size > 0 && !state.tierFilter.has(row.tier)) return false;
    return needle === '' || row.name.toLowerCase().includes(needle);
  });
  const dir = state.sortDesc ? -1 : 1;
  return rows.sort((a, b) => compareAttached(a, b, state.sortKey) * dir);
}

/**
 * Сравнение строк с добавлением по имени.
 *
 * Имя в конце обязательно: без него строки с равными значениями (а равных
 * значений в тирах много) переставлялись бы при каждой перерисовке, и список
 * подпрыгивал бы под курсором.
 */
function compareUnits(a: UnitIndexEntry, b: UnitIndexEntry, key: string): number {
  const left = cellValue(a, key);
  const right = cellValue(b, key);
  const byName = a.name.localeCompare(b.name, 'ru');
  if (key === 'tier') {
    return (TIER_ORDER[left as string] ?? 9) - (TIER_ORDER[right as string] ?? 9) || byName;
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).localeCompare(String(right), 'ru') || byName;
  }
  return left - right || byName;
}

function compareAttached(a: AttachedRow, b: AttachedRow, key: string): number {
  const byName = a.name.localeCompare(b.name, 'ru');
  if (key === 'tier') {
    return (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || byName;
  }
  const left = a[key as keyof AttachedRow];
  const right = b[key as keyof AttachedRow];
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).localeCompare(String(right), 'ru') || byName;
  }
  return Number(left) - Number(right) || byName;
}

/* ─────────────────────────  Каркас страницы  ───────────────────────── */

/**
 * Каркас строится один раз и дальше не пересоздаётся.
 *
 * Из-за этого перестал нужен костыль с возвратом фокуса в поиск: элемент
 * больше не исчезает из DOM при каждом нажатии клавиши. Заодно не теряются
 * позиция прокрутки и позиция курсора в строке.
 *
 * Прокручиваемый слой здесь один — `.scroll-shell`. Таблица без переноса ячеек
 * шире любого окна, где её видно (шестнадцать колонок, около 1810px), поэтому
 * горизонтальная прокрутка нужна; но пока ею владела `.table-wrap`, обёртка
 * заодно становилась контейнером прокрутки и по вертикали — и липкая шапка
 * прилипала к ней, а не к окну. Разбор целиком — в styles.css у
 * `.scroll-shell`.
 */
function mountShell(app: HTMLElement): void {
  app.innerHTML = `
    <div class="grain" aria-hidden="true"></div>
    <div class="scroll-shell" id="scroll-shell">
      <header class="masthead">
        <p class="eyebrow">Аналитический расчёт · 11-я редакция</p>
        <h1>Тирлист 40K</h1>
        <p class="subtitle">
          Все числа посчитаны движком сборки: нормы, Total и тир приходят готовыми.
          Клик по юниту открывает разбор — тир по всем видам боя, из чего сложились
          урон и живучесть, и вклад каждой способности.
        </p>
        <dl class="readout" id="readout"></dl>
      </header>
      <div class="controls" id="controls"></div>
      <p class="status" id="status" role="status" aria-live="polite"></p>
      <div class="table-wrap" id="table-wrap"></div>
    </div>
    <div id="dialog-root"></div>`;
}

/**
 * Высота панели управления — в CSS-переменную `--controls-h`.
 *
 * Шапка таблицы липнет ровно под панелью, но её высоту в CSS не выразить: на
 * узком окне контролы переносятся на вторую строку, и 87px превращаются в
 * 154px. Отсюда и взялось прежнее число 77px — оно не совпадало с настоящей
 * высотой ни на одной ширине, поэтому шапка отъезжала вниз и накрывала первые
 * строки.
 *
 * Меряется по факту и пересчитывается: шрифты приходят уже после первой
 * отрисовки, а вместе с ними меняется высота панели.
 *
 * Наблюдатель держится в переменной не для красоты: без живой ссылки его
 * забирает сборщик мусора, и панель, переехав на вторую строку, оставляет
 * шапке старую высоту. `resize` стоит рядом с ним как страхующий — если
 * наблюдателя всё-таки не окажется, окно всё равно пересчитает отступ.
 */
let controlsObserver: ResizeObserver | null = null;

function syncControlsHeight(app: HTMLElement): void {
  const controls = app.querySelector<HTMLElement>('#controls');
  if (controls === null) return;
  const apply = (): void => {
    app.style.setProperty('--controls-h', `${controls.getBoundingClientRect().height}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  if (typeof ResizeObserver !== 'undefined') {
    controlsObserver = new ResizeObserver(apply);
    controlsObserver.observe(controls);
  }
  /*
   * Шрифты приезжают уже после первой отрисовки и меняют высоту панели:
   * без этого шапка до первого ресайза стояла бы по «запасному» кеглю.
   */
  if (document.fonts !== undefined) void document.fonts.ready.then(apply);
}

/** Панель управления: собирается один раз, состояние — в aria-pressed. */
function mountControls(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#controls');
  if (host === null) return;
  const modes = MODES.map(
    (mode) => `<button type="button" data-mode="${mode.id}" aria-pressed="false">${mode.title}</button>`
  ).join('');
  const tierButtons = TIERS.map(
    (tier) =>
      `<button type="button" data-tier-only="${tier}" aria-pressed="false" title="Показать тир ${tier}">${tier}</button>`
  ).join('');
  const paradigms = (state.index?.paradigms ?? PARADIGM_FALLBACK)
    .map(
      (paradigm) =>
        `<button type="button" data-paradigm="${paradigm}" aria-pressed="false">${esc(PARADIGM_LABELS[paradigm] ?? paradigm)}</button>`
    )
    .join('');

  host.innerHTML = `
    <div class="control">
      <span class="control-label" id="label-view">Раздел</span>
      <div class="segmented" role="group" aria-labelledby="label-view">
        <button type="button" data-view="units" aria-pressed="false">Юниты</button>
        <button type="button" data-view="attached" aria-pressed="false">С лидером</button>
      </div>
    </div>
    <div class="control">
      <label class="control-label" for="faction">Фракция</label>
      <select id="faction"><option value="">Все фракции</option></select>
    </div>
    <div class="control">
      <span class="control-label" id="label-mode">Режим боя</span>
      <div class="segmented" role="group" aria-labelledby="label-mode">${modes}</div>
    </div>
    <div class="control">
      <span class="control-label" id="label-paradigm">Парадигма цели</span>
      <div class="segmented" role="group" aria-labelledby="label-paradigm">${paradigms}</div>
    </div>
    <div class="control">
      <span class="control-label" id="label-tier">Тиры</span>
      <div class="segmented tier-filter" role="group" aria-labelledby="label-tier">${tierButtons}</div>
    </div>
    <div class="control grow">
      <label class="control-label" for="search">Поиск</label>
      <input id="search" type="search" placeholder="Название юнита" autocomplete="off" spellcheck="false" />
    </div>`;

  const select = host.querySelector<HTMLSelectElement>('#faction');
  for (const faction of state.index?.factions ?? []) {
    const option = document.createElement('option');
    option.value = faction;
    option.textContent = faction;
    select?.append(option);
  }
}

/**
 * Проставляет нажатое состояние кнопок.
 *
 * Через aria-pressed, а не классом в разметке: состояние живёт здесь, и разовая
 * сборка HTML не может с ним разойтись.
 */
function syncControls(app: HTMLElement): void {
  const mark = (selector: string, isOn: (el: HTMLElement) => boolean): void => {
    for (const el of app.querySelectorAll<HTMLElement>(selector)) {
      el.setAttribute('aria-pressed', String(isOn(el)));
    }
  };
  mark('[data-view]', (el) => el.dataset.view === state.view);
  mark('[data-mode]', (el) => el.dataset.mode === state.mode);
  mark('[data-paradigm]', (el) => el.dataset.paradigm === state.targetParadigm);
  mark('[data-tier-only]', (el) => state.tierFilter.has(el.dataset.tierOnly as Tier));
  const select = app.querySelector<HTMLSelectElement>('#faction');
  if (select !== null) select.value = state.faction;
}

/** Сводка по тирам для строки состояния. */
function renderStatus(app: HTMLElement): void {
  const status = app.querySelector<HTMLElement>('#status');
  if (status === null) return;
  const attached = state.view === 'attached';
  const rows = attached ? visibleAttachedRows() : visibleUnits();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const tier = attached
      ? (row as AttachedRow).tier
      : cellOf(row as UnitIndexEntry, state.targetParadigm, state.mode)?.tier;
    if (tier !== undefined) counts[tier] = (counts[tier] ?? 0) + 1;
  }
  const parts = TIERS.map((tier) => `${tier}:${counts[tier] ?? 0}`).join('  ·  ');
  const section = attached ? 'Отряды с лидерами' : 'Юниты';
  status.textContent = `${section} · ${MODE_LABELS[state.mode]} · ${PARADIGM_LABELS[state.targetParadigm]} · ${parts} · всего ${rows.length}`;
}

/** Параметры сборки в шапке: их видно, чтобы число не выглядело выдуманным. */
function renderReadout(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#readout');
  const index = state.index;
  if (host === null || index === null) return;
  const generated = new Date(index.generatedAt);
  const stamp = Number.isNaN(generated.getTime())
    ? '—'
    : generated.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const items: Array<[string, string]> = [
    ['Прогонов на бой', String(index.trials)],
    ['Дистанция', `${index.distance}"`],
    ['Парадигм × режимов', `${index.paradigms.length} × ${index.modes.length}`],
    ['Сборка от', stamp],
  ];
  host.innerHTML = items
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');
}

/* ─────────────────────────  Таблица  ───────────────────────── */

/**
 * Заголовок сортируемой колонки.
 *
 * Клик и Enter/Space работают одинаково, а `aria-sort` живёт на `th`, как и
 * велит спецификация: программы чтения с экрана читают состояние сортировки
 * оттуда, а не из класса или символа-стрелки в тексте.
 */
function sortHeader(key: string, title: string, numeric: boolean, hint?: string): string {
  const active = state.sortKey === key;
  const ariaSort = active ? (state.sortDesc ? 'descending' : 'ascending') : 'none';
  const arrow = active ? `<span class="sort-arrow" aria-hidden="true">${state.sortDesc ? '▾' : '▴'}</span>` : '';
  return `<th scope="col" class="${numeric ? 'num' : ''}" aria-sort="${ariaSort}">
    <button type="button" class="sort-btn" data-sort="${key}" ${hint !== undefined ? `title="${esc(hint)}"` : ''}>
      <span>${esc(title)}</span>${arrow}
    </button>
  </th>`;
}

function renderTable(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#table-wrap');
  if (host === null) return;
  const units = visibleUnits();
  if (units.length === 0) {
    host.innerHTML = '<p class="empty">Ничего не найдено</p>';
    return;
  }

  const head = COLUMNS.map((column) => sortHeader(column.key, column.title, column.numeric, column.hint)).join('');
  const body = units.map((unit) => {
    const tier = cellOf(unit, state.targetParadigm, state.mode)?.tier ?? 'D';
    const cells = COLUMNS.filter((column) => column.key !== 'name')
      .map((column) => {
        const value = cellValue(unit, column.key);
        const text = BAR_COLUMNS.has(column.key)
          ? `${bar(Number(value))} ${num(Number(value))}`
          : typeof value === 'number'
            ? num(value)
            : esc(String(value));
        return `<td class="${column.numeric ? 'num' : ''}">${text}</td>`;
      })
      .join('');
    return `<tr>
      <th scope="row" class="unit-cell">
        <button type="button" class="tier-badge" data-tier="${tier}" data-open="${unit.id}" title="Открыть разбор юнита">${tier}</button>
        <button type="button" class="unit-name" data-open="${unit.id}">${esc(unit.name)}</button>
        ${sensitivityTag(unit)}
      </th>
      ${cells}
    </tr>`;
  }).join('');

  host.innerHTML = `<table>
    <caption class="sr-only">Тирлист юнитов: сортировка кликом по заголовку, детали по клику на название</caption>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

/** Пометка неустойчивого тира: она меняет доверие к строке, а не значение. */
function sensitivityTag(unit: UnitIndexEntry): string {
  const sensitivity = unit.sensitivity;
  if (sensitivity === undefined || (!sensitivity.high && !sensitivity.medium)) return '';
  const level = sensitivity.high ? 'HIGH' : 'MEDIUM';
  const percent = (sensitivity.tierChangeProbability * 100).toFixed(0);
  const title = `Тир меняется в ${percent}% сценариев возмущения (±15% и ±30% числа моделей в эталонных целях) — оценка держится на узком матчапе`;
  return `<span class="tag sens-mark" title="${esc(title)}">SENS ${level}</span>`;
}

/** Таблица юнитов с присоединёнными лидерами. */
function renderAttachedTable(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#table-wrap');
  if (host === null) return;
  if (state.attached === null) {
    host.innerHTML = '<p class="empty">Загрузка сочетаний «отряд + лидер»…</p>';
    return;
  }
  const rows = visibleAttachedRows();
  if (rows.length === 0) {
    host.innerHTML = '<p class="empty">Нет подходящих сочетаний «отряд + лидер».</p>';
    return;
  }
  const columns: Array<[string, string, boolean]> = [
    ['name', 'Отряд + лидер', false],
    ['points', 'Очки', true],
    ['models', 'Мод.', true],
    ['rawMaxDamage', 'Уничт. очки/100', true],
    ['bestTargetName', 'Лучшая цель', false],
    ['effectiveSurvivability', 'Живучесть', true],
    ['utilityScore', 'Полезность', true],
    ['totalScore', 'TOTAL', true],
    ['tier', 'Тир', false],
  ];
  const head = columns
    .map(([key, title, numeric]) => sortHeader(key, title, numeric))
    .join('');
  const body = rows
    .map((row) => {
      const leader = row.leaderId === null ? '—' : leaderNameOf(row.leaderId);
      return `<tr>
        <th scope="row" class="unit-cell">
          <button type="button" class="tier-badge" data-tier="${row.tier}" disabled>${row.tier}</button>
          <span class="unit-name plain">${esc(row.name)}</span>
        </th>
        <td>${esc(leader)}</td>
        <td class="num">${row.points}</td>
        <td class="num">${row.models}</td>
        <td class="num">${num(row.rawMaxDamage, 1)}</td>
        <td>${esc(row.bestTargetName)}</td>
        <td class="num">${num(row.effectiveSurvivability, 1)}</td>
        <td class="num">${row.utilityScore}</td>
        <td class="num">${num(row.totalScore, 1)}</td>
      </tr>`;
    })
    .join('');
  host.innerHTML = `<table>
    <caption class="sr-only">Сочетания «отряд + лидер» для выбранной парадигмы цели и режима боя</caption>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function leaderNameOf(id: string): string {
  return state.index?.leaders.find((leader) => leader.id === id)?.name ?? id;
}

/* ─────────────────────────  Панель деталей  ───────────────────────── */

/** Метрика выбранной ячейки из полной записи юнита. */
function detailCell(detail: UnitDetail): UnitMetrics | null {
  return detail.metricsByParadigm?.[state.targetParadigm]?.[state.mode] ?? detail.metricsByParadigm?.all?.[state.mode] ?? null;
}

/**
 * Человекочитаемый профиль оружия для карточки.
 */
function weaponProfileText(weapon: UnitProfile['models'][number]['weapons'][number]): string {
  const dice = (spec: { count: number; sides: number; plus: number } | null): string => {
    if (spec === null) return '-';
    if (spec.sides === 1) return String(spec.count + spec.plus);
    return `${spec.count}D${spec.sides}${spec.plus !== 0 ? (spec.plus > 0 ? `+${spec.plus}` : spec.plus) : ''}`;
  };
  return [
    weapon.kind === 'ranged' && weapon.range !== null ? `${weapon.range}"` : 'Melee',
    dice(weapon.attacks),
    weapon.skill === null ? '-' : `${weapon.skill}+`,
    weapon.strength === null ? '-' : `S${weapon.strength}`,
    `AP${weapon.ap}`,
    dice(weapon.damage),
  ].join(' · ');
}

/** Строка «название — полоса — число» для разбивок урона и живучести. */
function breakdownRow(label: string, value: number, max: number, digits: number): string {
  const width = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return `<div class="breakdown-row">
    <span class="bk">${esc(label)}</span>
    <span class="bar"><i style="width:${width.toFixed(1)}%"></i></span>
    <span class="bv">${num(value, digits)}</span>
  </div>`;
}

/** Плитка одного показателя. */
function metric(label: string, value: string, title?: string, note?: string): string {
  const hint = title !== undefined ? ` title="${esc(title)}"` : '';
  const small = note !== undefined ? `<small>${esc(note)}</small>` : '';
  return `<div class="metric"${hint}><div class="k">${esc(label)}</div><div class="v">${value}${small}</div></div>`;
}

/**
 * Матрица тиров по всем 12 комбинациям.
 *
 * Раньше в панели был только выбранный вид, и было не видно, является ли низкий
 * тир свойством юнита или следствием выбранной парадигмы цели. Матрица показывает
 * это прямо: если юнит S против пехоты и D против техники, виновата парадигма.
 */
function renderParadigmMatrix(detail: UnitDetail): string {
  const paradigms = state.index?.paradigms ?? PARADIGM_FALLBACK;
  const modes = state.index?.modes ?? ['combined'];
  const head = modes
    .map((mode) => `<th scope="col" class="num">${esc(MODE_LABELS[mode] ?? mode)}</th>`)
    .join('');
  const body = paradigms
    .map((paradigm) => {
      const cells = modes
        .map((mode) => {
          const cell = detail.metricsByParadigm?.[paradigm]?.[mode];
          if (cell === undefined) return '<td class="num">—</td>';
          const current = paradigm === state.targetParadigm && mode === state.mode;
          return `<td class="num${current ? ' current' : ''}">
            <span class="tier-badge" data-tier="${cell.tier}">${cell.tier}</span>
            <span class="cell-total">${num(cell.totalScore, 1)}</span>
          </td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(PARADIGM_LABELS[paradigm] ?? paradigm)}</th>${cells}</tr>`;
    })
    .join('');
  return `<section>
    <h3>Тир по всем видам боя</h3>
    <p class="hint">Все 12 комбинаций «парадигма цели × режим». Подсвечена та, что выбрана в фильтрах.</p>
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th scope="col">Парадигма цели</th>${head}</tr></thead>
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
function renderBreakdowns(detail: UnitDetail): string {
  const metrics = detailCell(detail);
  if (metrics === null) return '';
  const destroyed = metrics.destroyedPointsByTarget ?? {};
  const offenseMax = Math.max(1, ...Object.values(destroyed));
  const offense = Object.entries(destroyed)
    .map(([id, value]) => breakdownRow(TARGET_LABELS[id] ?? id, value, offenseMax, 1))
    .join('');
  const defense = metrics.defenseVector ?? {};
  const defenseMax = Math.max(1, ...Object.values(defense));
  const defenseRows = Object.entries(defense)
    .map(([group, value]) => breakdownRow(DEFENSE_GROUP_LABELS[group] ?? group, value, defenseMax, 2))
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
function renderUtilityDetails(detail: UnitDetail): string {
  const flags = detail.utilityFlags ?? [];
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
            `<span class="flag flag-${id}" title="${esc(flag.reason)}"><b>${esc(flag.id)}</b> +${flag.points} — ${esc(flag.reason)}</span>`
        )
        .join('');
      return `<div class="util-group">
        <h4>${esc(title)} <span class="muted">· ${esc(note)}</span></h4>
        <div class="flags">${chips}</div>
      </div>`;
    })
    .join('');
  return `<section>
    <h3>Небоевая полезность: ${detail.utilityScore} / 20</h3>
    <p class="hint">Сумма стратегических очков. Только они входят в Total.</p>
    ${body}
  </section>`;
}

/** Устойчивость тира к произвольным допущениям модели. */
function renderSensitivityDetails(detail: UnitDetail): string {
  const sensitivity = detail.sensitivity;
  if (sensitivity === undefined) {
    return '<section><h3>Чувствительность тира</h3><p class="hint">Нет данных: сборка шла с --skip-sensitivity.</p></section>';
  }
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;
  const verdict = sensitivity.high ? 'HIGH' : sensitivity.medium ? 'MEDIUM' : 'устойчив';
  return `<section>
    <h3>Чувствительность тира: ${verdict}</h3>
    <p class="hint">Тир пересчитывается при ±15% и ±30% числа моделей в эталонных целях.</p>
    <div class="metrics">
      ${metric('Смена тира', percent(sensitivity.tierChangeProbability))}
      ${metric('Разброс перцентиля', num(sensitivity.spread, 1))}
    </div>
  </section>`;
}

/**
 * Дельты одноразовых способностей.
 *
 * Отдельные справочные величины: показывают, насколько юнит прибавил бы с
 * одноразовым баффом, но в Total, нормы и тир не входят — «once per battle» не
 * действует постоянно. Поэтому здесь нули это норма, а не ошибка.
 *
 * Две величины, потому что способности делятся на классы: боевые (Trajann,
 * повторный залп Custodian Guard) видны в `damage`, защитные (Allarus-щит) — в
 * `survivability`. Одно число заставляло бы складывать разные сущности.
 */
function renderOnceEffectDetails(detail: UnitDetail): string {
  const damage = detail.onceEffectDeltas?.damage ?? 0;
  const survivability = detail.onceEffectDeltas?.survivability ?? 0;
  return `<section>
    <h3>Одноразовые способности</h3>
    <div class="metrics">
      ${metric('Δ уничтоженных очков', num(damage, 2), 'Сколько очков цели юнит уничтожил бы дополнительно с одноразовым баффом')}
      ${metric('Δ прожитых фаз', num(survivability, 2), 'Сколько боевых фаз юнит прожил бы дополнительно')}
    </div>
    <p class="hint">Справочно. В Total, нормы и тир не входит: способность срабатывает один раз за бой, а не постоянно. Боевые способности видны в уроне, защитные — в живучести.</p>
  </section>`;
}

/**
 * Варианты снаряжения.
 *
 * Метрики для loadout'ов в JSON намеренно нет (считать их для тысяч юнитов
 * дорого), поэтому показываются очки и состав оружия, а не выдуманные нули.
 */
function renderLoadoutDetails(detail: UnitDetail): string {
  const loadouts = detail.loadouts ?? [];
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
function renderLeaderDetails(detail: UnitDetail): string {
  const attached = state.attached?.attached?.[state.targetParadigm]?.[state.mode] ?? [];
  const rows = attached.filter((row) => row.unitId === detail.id);
  if (rows.length === 0) {
    return '<section><h3>С лидерами</h3><p class="hint">Для этого юнита в выбранном виде нет разрешённых лидеров.</p></section>';
  }
  const body = rows
    .map(
      (row) => `<tr>
      <td>${esc(row.name)}</td>
      <td>${esc(row.leaderId === null ? '—' : leaderNameOf(row.leaderId))}</td>
      <td class="num">${row.points}</td>
      <td class="num">${num(row.rawMaxDamage, 1)}</td>
      <td>${esc(row.bestTargetName)}</td>
      <td class="num">${num(row.totalScore, 1)}</td>
      <td><span class="tier-badge" data-tier="${row.tier}">${row.tier}</span></td>
    </tr>`
    )
    .join('');
  return `<section>
    <h3>С лидерами — ${esc(PARADIGM_LABELS[state.targetParadigm] ?? state.targetParadigm)}, ${esc(MODE_LABELS[state.mode].toLowerCase())}</h3>
    <div class="table-wrap"><table>
      <caption class="sr-only">Разрешённые лидеры для этого юнита</caption>
      <thead><tr>
        <th scope="col">Отряд</th><th scope="col">Лидер</th><th scope="col" class="num">Очки</th>
        <th scope="col" class="num">Уничт. очки/100</th><th scope="col">Лучшая цель</th>
        <th scope="col" class="num">TOTAL</th><th scope="col">Тир</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

/** Оружие юнита: состав и профили, без полей правки. */
function renderWeapons(detail: UnitDetail): string {
  const model = detail.unit?.models?.[0];
  if (model === undefined) return '';
  const onlyKind = state.mode === 'ranged' ? 'ranged' : state.mode === 'melee' ? 'melee' : 'both';
  const weapons = model.weapons.filter((weapon) => onlyKind === 'both' || weapon.kind === onlyKind);
  const cards = weapons
    .map(
      (weapon) => `<div class="weapon-card">
      <div class="whead">
        <span class="name">${esc(weapon.name)}</span>
        <span class="profile">${esc(weaponProfileText(weapon))}</span>
      </div>
      ${weapon.keywords.length === 0 ? '' : `<div class="weapon-keywords">${weapon.keywords
        .map((keyword) => `<span class="weapon-keyword" title="${esc(keyword.name)}">${esc(keyword.raw)}</span>`)
        .join('')}</div>`}
    </div>`
    )
    .join('');
  return `<section>
    <h3>Оружие${onlyKind === 'both' ? '' : ` — ${esc(MODE_LABELS[state.mode].toLowerCase())}`}</h3>
    ${cards || '<p class="hint">В выбранном режиме у юнита нет оружия.</p>'}
  </section>`;
}

/**
 * Панель деталей по юниту: только чтение, все числа берутся из сборки.
 *
 * Порядок секций — от «что это за юнит» к «почему такой тир»: сначала итог по
 * выбранному виду, затем как он меняется по парадигмам, затем из чего сложились
 * урон и живучесть, и только потом справочные величины.
 */
function renderDetails(detail: UnitDetail): string {
  const metrics = detailCell(detail);
  if (metrics === null) return '<p class="hint">Нет метрик для выбранного вида боя.</p>';
  const paradigm = (PARADIGM_LABELS[state.targetParadigm] ?? state.targetParadigm).toLowerCase();
  const mode = MODE_LABELS[state.mode].toLowerCase();

  const summary = `<section>
    <h3>Показатели — ${esc(paradigm)}, ${esc(mode)}</h3>
    <div class="metrics">
      ${metric('Тир', metrics.tier)}
      ${metric('Total', num(metrics.totalScore))}
      ${metric('Перцентиль', num(metrics.percentile))}
      ${metric('Урон/100', num(metrics.effectiveDamage, 2))}
      ${metric('Живучесть, фазы', num(metrics.effectiveSurvivability, 2), 'Сколько боевых фаз юнит доживает — это и есть выживаемость в тире', num(metrics.normSurvivability, 0))}
      ${metric('Прочность/100', num(metrics.absorbedPer100, 2), 'Поглощённый до смерти урон — диагностика, в тир не входит')}
      ${metric('Ран/100', num(metrics.bulkPer100, 2), 'Запас ран на 100 очков — диагностика, не метрика выживаемости')}
      ${metric('Норм. урон', num(metrics.normDamage))}
      ${metric('Норм. полезн.', num(metrics.normUtility))}
    </div>
    <p class="hint">Total = 0.55·норм.урон + 0.35·норм.живучесть + 0.10·норм.полезность.</p>
  </section>`;

  return [
    summary,
    renderParadigmMatrix(detail),
    renderBreakdowns(detail),
    renderOnceEffectDetails(detail),
    renderUtilityDetails(detail),
    renderSensitivityDetails(detail),
    renderLoadoutDetails(detail),
    renderLeaderDetails(detail),
    renderWeapons(detail),
  ].join('');
}

/* ─────────────────────────  Модальное окно  ───────────────────────── */

/** Элемент, открывший окно: фокус возвращается в него при закрытии. */
let lastFocused: HTMLElement | null = null;

/**
 * Модальное окно с подробностями по юниту.
 *
 * Полная запись едет отдельным файлом, поэтому у окна есть промежуточное
 * состояние — и это не украшение: без него панель либо мигает пустотой, либо
 * показывает числа юнита, к которому они не относятся.
 */
function renderDialog(app: HTMLElement): void {
  const root = app.querySelector<HTMLElement>('#dialog-root');
  if (root === null || state.open === null) {
    if (root !== null) root.innerHTML = '';
    return;
  }
  const { detail, error } = state.open;

  let body: string;
  if (error !== null) {
    body = `<p class="hint error">Не удалось загрузить разбор юнита: ${esc(error)}</p>`;
  } else if (detail === null) {
    body = '<p class="hint loading-note">Загрузка разбора…</p>';
  } else {
    const meta = `${detail.faction} · ${detail.points} очков · ${detail.models} моделей · ${detail.archetype}`;
    body = `
      <p class="dialog-sub">${esc(meta)}</p>
      ${renderDetails(detail)}`;
  }
  const title = detail?.name ?? 'Разбор юнита';

  root.innerHTML = `<div class="backdrop" id="details-backdrop">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1">
      <header class="dialog-head">
        <h2 id="dialog-title">${esc(title)}</h2>
        <button type="button" class="close" data-action="close" aria-label="Закрыть разбор юнита">✕</button>
      </header>
      <div class="dialog-body">${body}</div>
    </div>
  </div>`;
  root.querySelector<HTMLElement>('.dialog')?.focus();
}

/** Открытие панели: сначала пустое окно, затем содержимое по мере загрузки. */
async function openUnit(app: HTMLElement, id: string): Promise<void> {
  const trigger = app.querySelector<HTMLElement>(`[data-open="${CSS.escape(id)}"]`);
  lastFocused = trigger;
  state.open = { id, detail: detailCache.get(id) ?? null, error: null };
  renderDialog(app);

  if (detailCache.has(id)) return;
  try {
    const detail = await loadDetail(id);
    // Пока едет файл, пользователь мог открыть другой юнит или закрыть окно.
    if (state.open?.id !== id) return;
    state.open = { id, detail, error: null };
    renderDialog(app);
  } catch (error) {
    if (state.open?.id !== id) return;
    state.open = { id, detail: null, error: String(error) };
    renderDialog(app);
  }
}

function closeDialog(app: HTMLElement): void {
  state.open = null;
  renderDialog(app);
  lastFocused?.focus();
  lastFocused = null;
}

/** Элементы, по которым ходит Tab внутри окна. */
function focusablesIn(dialog: HTMLElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ),
  ];
}

/* ─────────────────────────  Рендер и события  ───────────────────────── */

/** Перерисовывает только то, что зависит от состояния. */
function render(app: HTMLElement): void {
  syncControls(app);
  if (state.view === 'attached') renderAttachedTable(app);
  else renderTable(app);
  renderStatus(app);
  renderDialog(app);
}

function renderAll(app: HTMLElement): void {
  renderReadout(app);
  render(app);
}

/** Переключение вкладки «с лидерами» подтягивает отдельный файл. */
async function switchView(app: HTMLElement, view: 'units' | 'attached'): Promise<void> {
  state.view = view;
  if (view === 'attached' && state.attached === null) {
    render(app);
    try {
      state.attached = await loadAttached();
    } catch (error) {
      const host = app.querySelector<HTMLElement>('#table-wrap');
      if (host !== null) {
        host.innerHTML = `<p class="empty">Не удалось загрузить сочетания «отряд + лидер»: ${esc(String(error))}</p>`;
      }
      return;
    }
  }
  render(app);
  renderDialog(app);
}

function bindEvents(app: HTMLElement): void {
  app.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    const closeButton = target.closest<HTMLElement>('[data-action="close"]');
    if (closeButton !== null) {
      closeDialog(app);
      return;
    }
    // Клик по подложке закрывает окно; клик по самому окну — нет.
    if (target.id === 'details-backdrop') {
      closeDialog(app);
      return;
    }

    const openLink = target.closest<HTMLElement>('[data-open]');
    if (openLink?.dataset.open !== undefined) {
      void openUnit(app, openLink.dataset.open);
      return;
    }

    const sortButton = target.closest<HTMLElement>('[data-sort]');
    if (sortButton?.dataset.sort !== undefined) {
      const key = sortButton.dataset.sort;
      if (state.sortKey === key) state.sortDesc = !state.sortDesc;
      else {
        state.sortKey = key;
        state.sortDesc = true;
      }
      render(app);
      return;
    }

    const viewButton = target.closest<HTMLElement>('[data-view]');
    if (viewButton?.dataset.view !== undefined) {
      void switchView(app, viewButton.dataset.view as 'units' | 'attached');
      return;
    }

    const modeButton = target.closest<HTMLElement>('[data-mode]');
    if (modeButton?.dataset.mode !== undefined) {
      state.mode = modeButton.dataset.mode as CombatMode;
      render(app);
      return;
    }

    const paradigmButton = target.closest<HTMLElement>('[data-paradigm]');
    if (paradigmButton?.dataset.paradigm !== undefined) {
      state.targetParadigm = paradigmButton.dataset.paradigm as TargetParadigm;
      render(app);
      return;
    }

    const tierButton = target.closest<HTMLElement>('[data-tier-only]');
    if (tierButton?.dataset.tierOnly !== undefined) {
      const tier = tierButton.dataset.tierOnly as Tier;
      if (state.tierFilter.has(tier)) state.tierFilter.delete(tier);
      else state.tierFilter.add(tier);
      render(app);
    }
  });

  app.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.id === 'faction') {
      state.faction = target.value;
      render(app);
    }
  });

  /**
   * Поиск с задержкой.
   *
   * Без неё на каждый символ перерисовывалось бы до 1093 строк на 16 колонок.
   * Задержка не заметна глазом, а ввода успевает набрать несколько букв.
   */
  let searchTimer = 0;
  app.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id !== 'search') return;
    state.search = target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => render(app), SEARCH_DEBOUNCE_MS);
  });

  app.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open !== null) {
      event.preventDefault();
      closeDialog(app);
      return;
    }
    // Ловушка фокуса: без неё Tab уводит за пределы окна на страницу под ним.
    if (event.key !== 'Tab' || state.open === null) return;
    const dialog = app.querySelector<HTMLElement>('.dialog');
    if (dialog === null) return;
    const focusables = focusablesIn(dialog);
    if (focusables.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/* ─────────────────────────  Запуск  ───────────────────────── */

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app === null) return;
  try {
    state.index = await loadIndex();
    mountShell(app);
    mountControls(app);
    syncControlsHeight(app);
    renderAll(app);
  } catch (error) {
    app.innerHTML = `<div class="empty">
      <p>Не удалось загрузить данные тирлиста.</p>
      <p class="hint">${esc(String(error))}</p>
      <p class="hint">Соберите их командой <code>npm run build:data</code>.</p>
    </div>`;
  }
}

const root = document.querySelector<HTMLDivElement>('#app');
if (root !== null) {
  bindEvents(root);
  void boot();
}










