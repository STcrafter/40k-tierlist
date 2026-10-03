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
  LEADER_COLUMN_KEYS,
  type AttachedData,
  type AttachedRow,
  type CombatMode,
  type IndexData,
  type LeaderScoreData,
  type LeaderScoreRow,
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
const LEADERS_URL = './data/leaders.json';
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

/**
 * Раздел тирлиста: юниты, пары «отряд + лидер» или сводка по самим лидерам.
 *
 * Сводка отвечает на другой вопрос, чем пары: пара — «насколько хороша вот эта
 * связка», сводка — «какого лидера стоит взять».
 */
type View = 'units' | 'attached' | 'leaders';

const state = {
  index: null as IndexData | null,
  attached: null as AttachedData | null,
  mode: 'combined' as CombatMode,
  targetParadigm: 'all' as TargetParadigm,
  faction: '',
  /**
   * Подфракция внутри выбранной гиперфракции (чаптер, легион, Ynnari).
   *
   * Пустая строка — «все подфракции». Отдельное поле, а не часть `faction`:
   * в списке фракций 12 чаптеров Adeptus Astartes засоряли бы его сильнее, чем
   * дают реальную пользу.
   */
  subFaction: '',
  tierFilter: new Set<Tier>(),
  search: '',
  sortKey: 'totalScore',
  sortDesc: true,
  /**
   * Показывать лидеров и Support в основной вкладке. По умолчанию выключено:
   * это не боевые отряды, они стоят в общей шкале и выглядят слабыми.
   *
   * Расчёта это НЕ касается — перцентили и тиры считаются по всем строкам.
   * Фильтр чисто интерфейсный, иначе скрытие сдвинуло бы положение всех
   * настоящих юнитов.
   */
  showLeaders: false,
  view: 'units' as View,
  leaders: null as LeaderScoreData | null,
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

/**
 * Сводка по лидерам грузится один раз за сессию.
 *
 * Кэшируется промис, как `attachedPromise`, по той же причине: переключение
 * туда-обратно не должно слать повторный запрос.
 */
let leadersPromise: Promise<LeaderScoreData> | null = null;

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

/** Сводка по лидерам; файл маленький, но запрос тоже кэшируется на сессию. */
function loadLeaders(): Promise<LeaderScoreData> {
  leadersPromise ??= (async () => {
    const response = await fetch(LEADERS_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as LeaderScoreData;
  })();
  return leadersPromise;
}

/* ─────────────────────────  Подписи и формат  ───────────────────────── */

/** Форматирование чисел для таблицы. */
const num = (value: number, digits = 1): string => value.toFixed(digits);

/**
 * Дельта со знаком: плюс виден глазом сразу, а в колонке без знака минус легко
 * пропустить, а дельта — это ровно та величина, ради которой смотрят в столбец.
 */
const signed = (value: number, digits = 1): string =>
  `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

/** Класс подписи дельты. Нулевую подсвечивать незачем — её и так не видно. */
const deltaClass = (value: number): string =>
  value > 0 ? 'delta-up' : value < 0 ? 'delta-down' : '';

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
    if (unit.isLeader && !state.showLeaders) return false;
    if (state.faction && !unit.factions.includes(state.faction)) return false;
    // Общие юниты (subFaction === null) видны в каждом подразделении: по
    // решению владельца проекта Intercessor Squad показывается и под Blood
    // Angels, и под Ultramarines, потому что он реально годятся обоим.
    if (state.subFaction && unit.subFaction !== null && unit.subFaction !== state.subFaction) {
      return false;
    }
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

/**
 * Сортировка строк сводки по лидерам.
 *
 * Отдельная функция, а не переиспользование `compareAttached`: набор колонок
 * другой и значения тут — средние, а не результаты отдельных пар. Имя в конце
 * — по той же причине, что и в остальных компараторах: иначе строки с равным
 * баллом переставлялись бы при каждой перерисовке.
 */
function compareLeader(a: LeaderScoreRow, b: LeaderScoreRow, key: string): number {
  const byName = a.name.localeCompare(b.name, 'ru');
  const left = a[key as keyof LeaderScoreRow];
  const right = b[key as keyof LeaderScoreRow];
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).localeCompare(String(right), 'ru') || byName;
  }
  return Number(left) - Number(right) || byName;
}

/**
 * Ключи колонок вкладки «Лидеры» берутся из model.ts: см. объявление и
 * причину, почему список нельзя держать в разметке.
 */
const LEADER_COLUMNS = LEADER_COLUMN_KEYS;

/**
 * Отфильтрованные и отсортированные лидеры.
 *
 * Тиров и перцентилей здесь нет: сводка своя шкала, а не часть общей сетки.
 * Поэтому фильтр по тирам на этой вкладке скрывается — оставлять его значило бы
 * показать control, который тихо ничего не делает.
 */
function visibleLeaderRows(): LeaderScoreRow[] {
  if (state.leaders === null) return [];
  const needle = state.search.trim().toLowerCase();
  const rows = state.leaders.leaders.filter((row) => {
    if (state.faction && row.faction !== state.faction) return false;
    return needle === '' || row.name.toLowerCase().includes(needle);
  });
  const dir = state.sortDesc ? -1 : 1;
  return rows.sort((a, b) => compareLeader(a, b, state.sortKey) * dir);
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
        <button type="button" data-view="leaders" aria-pressed="false"
          title="Сводка по самим лидерам: насколько лидер поднимает свои отряды и во что они превращаются. Считается по объединённой сетке «все отряды, смешанный бой», поэтому режим боя и парадигма цели здесь не при чём.">
          Лидеры
        </button>
      </div>
    </div>
    <div class="control">
      <label class="control-label" for="faction">Фракция</label>
      <select id="faction"><option value="">Все фракции</option></select>
    </div>
    <div class="control" id="subfaction-control" hidden>
      <label class="control-label" for="subfaction">Подфракция</label>
      <select id="subfaction"></select>
    </div>
    <div class="control" data-unit-view>
      <span class="control-label" id="label-mode">Режим боя</span>
      <div class="segmented" role="group" aria-labelledby="label-mode">${modes}</div>
    </div>
    <div class="control" data-unit-view>
      <span class="control-label" id="label-paradigm">Парадигма цели</span>
      <div class="segmented" role="group" aria-labelledby="label-paradigm">${paradigms}</div>
    </div>
    <div class="control" data-unit-view>
      <span class="control-label" id="label-tier">Тиры</span>
      <div class="segmented tier-filter" role="group" aria-labelledby="label-tier">${tierButtons}</div>
    </div>
    <div class="control" data-unit-view>
      <span class="control-label" id="label-leaders">Лидеры</span>
      <button type="button" data-show-leaders aria-pressed="false"
        title="Показать Leader и Support в основной вкладке. Они считаются в общей шкале с боевыми юнитами и почти всегда выглядят слабыми — но их собственные тиры посчитаны честно.">
        Показать
      </button>
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
  mark('[data-show-leaders]', () => state.showLeaders);
  const select = app.querySelector<HTMLSelectElement>('#faction');
  if (select !== null) select.value = state.faction;
  syncSubFactionControl(app);
  /*
   * Режим боя, парадигма цели и тиры к сводке по лидерам отношения не имеют:
   * она считается по одной объединённой сетке. Эти контролы скрываются, а не
   * остаются видимыми и бесполезными — иначе переключение режима на этой
   * вкладке выглядело бы как поломка. Фильтр по тирам убрать пришлось
   * отдельно от остальных: у лидеров своих тиров нет вовсе.
   */
  const leadersView = state.view === 'leaders';
  for (const el of app.querySelectorAll<HTMLElement>('[data-unit-view]')) {
    el.hidden = leadersView;
  }
  const search = app.querySelector<HTMLInputElement>('#search');
  if (search !== null) search.placeholder = leadersView ? 'Название лидера' : 'Название юнита';
}

/**
 * Переключатель подфракций: показывается только у гиперфракций.
 *
 * Опции берутся из данных (`index.subFactions`), а не из зашитого списка: после
 * обновления BSData подразделение без юнитов исчезнет само, а не останется
 * пустым пунктом. Пересобирается только состав опций — сам select живёт в
 * каркасе, иначе терялся бы фокус при каждом изменении фракции.
 */
function syncSubFactionControl(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#subfaction-control');
  const select = app.querySelector<HTMLSelectElement>('#subfaction');
  if (host === null || select === null) return;

  const options = state.faction === '' ? undefined : state.index?.subFactions[state.faction];
  const available = options ?? [];
  host.hidden = available.length === 0;
  if (available.length === 0) {
    state.subFaction = '';
    return;
  }
  // Значение сбрасывается, если подразделения в новой фракции нет: иначе после
  // перехода «Adeptus Astartes → Aeldari» остался бы ключ от другой
  // гиперфракции и фильтр молча отсёк бы всё.
  if (state.subFaction !== '' && !available.includes(state.subFaction)) state.subFaction = '';

  const wanted = ['', ...available];
  const current = [...select.options].map((option) => option.value);
  if (current.join(' ') !== wanted.join(' ')) {
    select.innerHTML = '';
    for (const value of wanted) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === '' ? 'Все подфракции' : value;
      select.append(option);
    }
  }
  select.value = state.subFaction;
}

/** Сводка по тирам для строки состояния. */
function renderStatus(app: HTMLElement): void {
  const status = app.querySelector<HTMLElement>('#status');
  if (status === null) return;
  // У сводки по лидерам нет ни тиров, ни режима боя: это своя шкала по одной
  // объединённой сетке. Печатать там «S:0·A:0» и название парадигмы значило бы
  // показывать нули, будто это счёт.
  if (state.view === 'leaders') {
    status.textContent = `Лидеры · сводка по объединённой сетке «все отряды, смешанный бой» · всего ${visibleLeaderRows().length}`;
    return;
  }
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
    ['deltaPercentile', 'Δ Перц.', true],
    ['deltaDamage', 'Δ Урон', true],
    ['deltaSurvivability', 'Δ Живуч.', true],
    ['totalScore', 'TOTAL', true],
    // Перцентиль показывает, ЧТО ИМЕННО сравнивается: пары стоят в одной шкале
    // с обычными юнитами основной вкладки, а не среди себе. Без этой колонки
    // смену шкалы нельзя заметить со стороны.
    ['percentile', 'Перц.', true],
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
        <td class="num ${deltaClass(row.deltaPercentile)}">${signed(row.deltaPercentile)}</td>
        <td class="num ${deltaClass(row.deltaDamage)}">${signed(row.deltaDamage)}</td>
        <td class="num ${deltaClass(row.deltaSurvivability)}">${signed(row.deltaSurvivability)}</td>
        <td class="num">${num(row.totalScore, 1)}</td>
        <td class="num">${num(row.percentile, 1)}</td>
      </tr>`;
    })
    .join('');
  host.innerHTML = `<table>
    <caption class="sr-only">Сочетания «отряд + лидер» для выбранной парадигмы цели и режима боя. Пары и обычные юниты ранжированы в одной шкале</caption>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function leaderNameOf(id: string): string {
  return state.index?.leaders.find((leader) => leader.id === id)?.name ?? id;
}

/**
 * Таблица сводки по лидерам: «какого лидера стоит взять».
 *
 * Подъём и результат показываются и сырыми, и после усадки. Сырые — это то,
 * что на самом деле вышло из пар, а усадка оттягивает строки с малым числом пар
 * к среднему по рынку: у половины лидеров пар меньше трёх, и без неё таблица
 * награждала бы шум. Число пар стоит рядом обязательно — по нему видно, чему
 * верить в конкретной строке.
 */
function renderLeadersTable(app: HTMLElement): void {
  const host = app.querySelector<HTMLElement>('#table-wrap');
  if (host === null) return;
  if (state.leaders === null) {
    host.innerHTML = '<p class="empty">Загрузка сводки по лидерам…</p>';
    return;
  }
  const rows = visibleLeaderRows();
  if (rows.length === 0) {
    host.innerHTML = '<p class="empty">Нет лидеров, подходящих под фильтры.</p>';
    return;
  }
  const columns: Array<[string, string, boolean, string?]> = [
    ['name', 'Лидер', false],
    ['faction', 'Фракция', false],
    ['points', 'Очки', true, 'Сколько стоит сам лидер.'],
    [
      'pairs',
      'Пары',
      true,
      'Сколько пар за лидером. У половины лидеров их меньше трёх — такой строке и верь слабее.',
    ],
    [
      'lift',
      'Подъём',
      true,
      'На сколько мест в общей шкале лидер поднял свои отряды. Отвечает на вопрос «что он делает».',
    ],
    ['liftShrunk', 'Подъём (усад.)', true, 'То же, но стянутое к среднему по рынку по числу пар.'],
    ['result', 'Результат', true, 'Во что превращаются отряды с лидером.'],
    ['score', 'Балл', true, 'Итоговый балл = результат после усадки. Ранжирование по нему.'],
    [
      'improvedShare',
      'Доля улучшений',
      true,
      'В скольких парах лидер поднял отряд, а не опустил.',
    ],
  ];
  const head = columns
    .map(([key, title, numeric, hint]) => sortHeader(key, title, numeric, hint))
    .join('');
  const body = rows
    .map((row) => {
      return `<tr>
        <th scope="row" class="unit-cell">
          <span class="unit-name plain">${esc(row.name)}</span>
        </th>
        <td>${esc(row.faction)}</td>
        <td class="num">${row.points}</td>
        <td class="num">${row.pairs}</td>
        <td class="num ${deltaClass(row.lift)}">${signed(row.lift, 2)}</td>
        <td class="num ${deltaClass(row.liftShrunk)}">${signed(row.liftShrunk, 2)}</td>
        <td class="num">${num(row.result, 2)}</td>
        <td class="num">${num(row.score, 2)}</td>
        <td class="num">${(row.improvedShare * 100).toFixed(0)}%</td>
      </tr>`;
    })
    .join('');
  host.innerHTML = `<table>
    <caption class="sr-only">Сводка по лидерам: насколько лидер поднимает свои отряды и во что они превращаются. Считается по объединённой сетке «все отряды, смешанный бой»</caption>
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
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
  // Что выбрано в режиме, который сейчас открыт, и по каждому типу цели внутри
  // него. Сборки без снаряжения в списке нет — базовый отряд вынесен отдельно.
  const current = detailCell(detail);
  const chosenId = current?.bestLoadoutId ?? 'base';
  const byTarget = current?.loadoutByTarget ?? {};

  // Выбор показывается по всем трём режимам: против техники и против пехоты
  // лучшими могут быть разные сборки, а одна «лучшая на всё время» сборка —
  // это компромисс, которого в игре не бывает.
  const modeRows = (['ranged', 'melee', 'combined'] as CombatMode[])
    .map((mode) => {
      const metrics = detail.metricsByParadigm?.[state.targetParadigm]?.[mode];
      const name = metrics?.bestLoadoutName ?? 'Базовый';
      const points = metrics?.bestLoadoutPoints ?? detail.points;
      const active = mode === state.mode ? ' class="active"' : '';
      return `<tr${active}><th scope="row">${esc(MODE_LABELS[mode] ?? mode)}</th>` +
        `<td>${esc(name)}</td><td class="num">${points}</td></tr>`;
    })
    .join('');
  const modeTable = `<table class="loadout-modes">
      <thead><tr><th scope="col">Режим боя</th><th scope="col">Выбранное снаряжение</th><th scope="col" class="num">Очки</th></tr></thead>
      <tbody>${modeRows}</tbody>
    </table>`;

  // Какие типы цели выбирают снаряжение, отличное от базового отряда.
  const specialised = Object.entries(byTarget).filter(([, loadout]) => loadout.id !== 'base');
  const specialisedHint = specialised.length === 0
    ? '<p class="hint">Во всех режимах лучшим остаётся базовый отряд.</p>'
    : `<p class="hint">Снаряжение выбирается против: ${specialised
        .map(([id, loadout]) => `${esc(TARGET_LABELS[id] ?? id)} — ${esc(loadout.name)}`)
        .join('; ')}.</p>`;

  if (loadouts.length === 0) {
    return `<section><h3>Снаряжение</h3>${modeTable}${specialisedHint}</section>`;
  }
  const weaponsLine = (list: Array<{ name: string }>): string =>
    list.length === 0 ? '—' : list.map((weapon) => esc(weapon.name)).join(', ');
  const card = (name: string, points: number, weapons: Array<{ name: string }>, chosen: boolean): string => {
    const cls = chosen ? ' chosen' : '';
    const badge = chosen ? '<span class="badge">выбрано в этом режиме</span>' : '';
    return `<div class="weapon-card${cls}">
        <div class="whead">
          <span class="name">${esc(name)}</span>
          <span class="profile">${points} очков ${badge}</span>
        </div>
        <div class="profile">${weaponsLine(weapons)}</div>
      </div>`;
  };
  const body = [
    // Базовая сборка показывается тоже. Иначе юнит, у которого снаряжение
    // выбирается между вариантами ВНУТРИ варианта модели (Sekhetar Robots:
    // meltagun или warpflame projector and claw), выглядит так, будто вариантов
    // нет: список состоит из одной альтернативы, а базовой сборки в нём нет.
    card(
      'Базовый отряд',
      detail.points,
      (detail.unit?.models ?? []).flatMap((model) => model.weapons ?? []),
      chosenId === 'base'
    ),
    ...loadouts.map((loadout) =>
      card(
        loadout.name,
        loadout.points,
        (loadout.unit?.models?.[0]?.weapons ?? []) as Array<{ name: string }>,
        loadout.id === chosenId
      )
    ),
  ].join('');
  return `<section>
    <h3>Снаряжение</h3>
    ${modeTable}
    ${specialisedHint}
    ${body}
  </section>`;
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
  else if (state.view === 'leaders') renderLeadersTable(app);
  else renderTable(app);
  renderStatus(app);
  renderDialog(app);
}

function renderAll(app: HTMLElement): void {
  renderReadout(app);
  render(app);
}

/** Переключение раздела подтягивает отдельный файл, если он ещё не гружен. */
async function switchView(app: HTMLElement, view: View): Promise<void> {
  state.view = view;
  /*
   * Ключ сортировки приходит из прошлого раздела, а набор колонок у разделов
   * разный. Оставить чужой нельзя: `Number(undefined)` даёт NaN, сравнение
   * становится всегда ложным, и строки замирают в случайном порядке без
   * всякой видимой причины. Список ключей сводки — единственный, который нужно
   * знать наверняка: выйдя из неё, любой её ключ в других разделах не имеет
   * смысла (кроме «name», который есть везде и сбрасывать незачем).
   */
  const leaderKeys = LEADER_COLUMNS as readonly string[];
  const leaderOnly = leaderKeys.filter((key) => key !== 'name');
  if (view === 'leaders' && !leaderKeys.includes(state.sortKey)) {
    state.sortKey = 'score';
    state.sortDesc = true;
  } else if (view !== 'leaders' && leaderOnly.includes(state.sortKey)) {
    state.sortKey = 'totalScore';
    state.sortDesc = true;
  }
  if (view === 'leaders' && state.leaders === null) {
    render(app);
    try {
      state.leaders = await loadLeaders();
    } catch (error) {
      const host = app.querySelector<HTMLElement>('#table-wrap');
      if (host !== null) {
        host.innerHTML = `<p class="empty">Не удалось загрузить сводку по лидерам: ${esc(String(error))}</p>`;
      }
      return;
    }
  }
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
      const view = viewButton.dataset.view;
      if (view === 'units' || view === 'attached' || view === 'leaders') {
        void switchView(app, view);
      }
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
      return;
    }

    // Переключатель лидеров виден только в основной вкладке: во вкладке пар
    // лидер и так стоит в каждой строке отдельной колонкой.
    const leadersButton = target.closest<HTMLElement>('[data-show-leaders]');
    if (leadersButton !== null && state.view === 'units') {
      state.showLeaders = !state.showLeaders;
      render(app);
    }
  });

  app.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
    if (target.id === 'faction') {
      state.faction = target.value;
      // Подфракция чужой гиперфракции сбрасывается в syncSubFactionControl:
      // «Adeptus Astartes → Blood Angels» иначе оставил бы ключ от астартесов.
      render(app);
      return;
    }
    if (target.id === 'subfaction') {
      state.subFaction = target.value;
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










