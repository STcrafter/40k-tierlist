/**
 * Главный модуль веб-тирлиста.
 *
 * Отвечает за: фильтры (фракция, режим боя, тир, поиск), таблицу со всеми
 * показателями и панель редактора характеристик. Пересчёт после правки
 * идёт в браузере тем же кодом, что и на сервере (src/tier + src/combat),
 * поэтому цифры на сайте и в отчётах совпадают.
 */

import { damagePerRound } from '../../src/combat/perRound.ts';
import { survivabilityAgainstUnit } from '../../src/combat/survival.ts';
import { CALCULATION_POINTS_LIMIT, withinCalculationBudget } from '../../src/combat/budget.ts';
import type { CombatUnit, CombatWeapon } from '../../src/combat/types.ts';
import {
  rebuildTierlist,
  type CombatMode,
  type ScoredRow,
  type Tier,
  type TierlistData,
  type UnitEntry,
  type UnitProfile,
} from './model.ts';

const DATA_URL = './data/tierlist.json';

interface UnitMetricsLocal {
  rawMaxDamage: number;
  bestSlot: 'infantry' | 'armor' | 'universal';
  vsInfantry: number;
  vsArmor: number;
  universal: number;
  baseSurvivability: number;
  takenPer100: number;
  unitType: 'Ranged' | 'Melee';
  taxDamage: number;
  taxSurvivability: number;
  effectiveDamage: number;
  effectiveSurvivability: number;
  utilityFlags: Array<{ id: string; points: number; reason: string }>;
  utilityScore: number;
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  totalScore: number;
  percentile: number;
  tier: Tier;
}

const MODES: Array<{ id: CombatMode; title: string }> = [
  { id: 'ranged', title: 'Дальний бой' },
  { id: 'melee', title: 'Ближний бой' },
  { id: 'combined', title: 'Комбинированный' },
];

const TIERS: Tier[] = ['S', 'A', 'B', 'C', 'D'];

const state = {
  data: null as TierlistData | null,
  mode: 'combined' as CombatMode,
  faction: '',
  tierFilter: new Set<Tier>(),
  search: '',
  sortKey: 'totalScore',
  sortDesc: true,
  edited: new Map<string, UnitProfile>(),
  overrides: new Map<string, UnitMetricsLocal>(),
  /** Пересчитанные строки тирлиста (id → строка). */
  rows: new Map<string, ScoredRow>(),
  openUnit: null as UnitEntry | null,
};


/** Профиль юнита из JSON → боевой отряд для симулятора. */
function toCombatUnit(profile: UnitProfile): CombatUnit {
  return {
    id: profile.id,
    name: profile.name,
    keywords: profile.keywords,
    models: profile.models.map((model) => ({
      id: model.id,
      name: model.name,
      toughness: model.toughness,
      wounds: model.wounds,
      save: model.save,
      invuln: model.invuln,
      keywords: model.keywords,
      weapons: model.weapons.map(
        (weapon): CombatWeapon => ({
          id: weapon.id,
          name: weapon.name,
          kind: weapon.kind,
          range: weapon.range,
          attacks: weapon.attacks,
          skill: weapon.skill,
          strength: weapon.strength,
          ap: weapon.ap,
          damage: weapon.damage,
          // Кейворды нужны для [LETHAL HITS]/[ANTI-X]; в JSON храним только
          // имя и исходный текст, поэтому condition не восстанавливается.
          keywords: weapon.keywords.map((keyword) => ({
            name: keyword.name,
            raw: keyword.raw,
            value: null,
            target: null,
            condition: null,
          })),
        })
      ),
    })),
  };
}

/** Целевые архетипы делятся на пехоту и броню — как в src/tier/scoring.ts. */
const INFANTRY_TARGETS = [
  'infantry',
  'infantry-veteran',
  'swarm',
  'terminator',
  'jetpack',
  'cavalry',
] as const;

const ARMOR_TARGETS = [
  'monster',
  'walker',
  'vehicle',
  'transport',
  'flyer',
  'battlesuit',
  'fortification',
] as const;

/**
 * Пересчитывает сырые метрики одного юнита в выбранном режиме боя.
 * Дублирует логику src/tier/scoring.ts (rawScoreOf), но по отредактированному
 * профилю: серверные цифры без повторного прогона пересчитать нельзя.
 */
function recomputeMetrics(
  unit: UnitEntry,
  profile: UnitProfile,
  mode: CombatMode
): UnitMetricsLocal {
  const combatUnit = toCombatUnit(profile);
  const points = profile.points;
  const scale = points > 0 ? 100 / points : 0;
  const phase = mode === 'ranged' ? 'ranged' : mode === 'melee' ? 'melee' : 'all';

  // Прогонов меньше, чем при сборке: правка идёт в интерактиве, а на
  // нормированный скор доли процента почти не влияют.
  const damage = damagePerRound(combatUnit, {
    trials: 24,
    distance: state.data?.distance ?? 12,
    phase,
    targets: [...INFANTRY_TARGETS, ...ARMOR_TARGETS],
  });
  const slice = mode === 'ranged' ? damage.ranged : mode === 'melee' ? damage.melee : damage.total;
  const per100 = (ids: readonly string[]): number =>
    average(ids.map((id) => slice.byArchetype[id]?.mean ?? 0)) * scale;

  const vsInfantry = per100(INFANTRY_TARGETS);
  const vsArmor = per100(ARMOR_TARGETS);
  const universal = slice.overall.mean * scale;
  const candidates: Array<[UnitMetricsLocal['bestSlot'], number]> = [
    ['infantry', vsInfantry],
    ['armor', vsArmor],
    ['universal', universal],
  ];
  const [bestSlot, rawMaxDamage] = candidates.reduce((best, current) =>
    current[1] > best[1] ? current : best
  );

  // Живучесть — ограниченная стоимостная шкала: 100 / (1 + takenPer100).
  const surv = survivabilityAgainstUnit(combatUnit, points, {
    trials: 16,
    maxRounds: 12,
    distance: state.data?.distance ?? 12,
    phase,
  });
  const takenPer100 = surv.overall.takenPer100Points.mean;
  const baseSurvivability = 100 / (1 + takenPer100);

  const rangedPer100 = damage.ranged.overall.mean * scale;
  const meleePer100 = damage.melee.overall.mean * scale;
  const unitType: 'Ranged' | 'Melee' = meleePer100 > rangedPer100 ? 'Melee' : 'Ranged';
  const hasFlyOrDeepStrike = combatUnit.keywords.includes('FLY');
  const tax =
    unitType === 'Ranged'
      ? { damage: 1, survivability: 1 }
      : hasFlyOrDeepStrike
        ? { damage: 0.85, survivability: 0.85 }
        : { damage: 0.7, survivability: 0.6 };

  return {
    rawMaxDamage,
    bestSlot,
    vsInfantry,
    vsArmor,
    universal,
    baseSurvivability,
    takenPer100,
    unitType,
    taxDamage: tax.damage,
    taxSurvivability: tax.survivability,
    effectiveDamage: rawMaxDamage * tax.damage,
    effectiveSurvivability: baseSurvivability * tax.survivability,
    utilityFlags: unit.utilityFlags,
    // Utility не зависит от боевых характеристик — остаётся серверный.
    utilityScore: unit.utilityScore,
    normDamage: 0,
    normSurvivability: 0,
    normUtility: 0,
    totalScore: 0,
    percentile: 50,
    tier: 'D',
  };
}


/** Текущая стоимость юнита с учётом правок редактора. */
function pointsOf(unit: UnitEntry): number {
  return (state.edited.get(unit.id) ?? unit.unit).points;
}

/** Метрики юнита: отредактированные — из кэша, иначе из собранных данных. */
function metricsOf(unit: UnitEntry): UnitMetricsLocal {
  const override = state.overrides.get(`${unit.id}:${state.mode}`);
  if (override) return override;
  const base = unit.metrics[state.mode];
  return { ...base } as UnitMetricsLocal;
}

/**
 * Пересобирает тирлист целиком: сырые метрики → нормировка → Total → тиры.
 * Вызывается при смене режима боя, фильтров и после каждой правки юнита.
 */
function rebuildRows(): void {
  if (!state.data) return;
  state.rows = rebuildTierlist(
    state.data.units
      .filter((unit) => withinCalculationBudget(pointsOf(unit)))
      .map((unit) => ({ id: unit.id, raw: metricsOf(unit) }))
  );
}

/** Отфильтрованные и отсортированные юниты для таблицы. */
function visibleUnits(): UnitEntry[] {
  if (!state.data) return [];
  const needle = state.search.trim().toLowerCase();
  const rows = state.data.units.filter((unit) => {
    if (!withinCalculationBudget(pointsOf(unit))) return false;
    if (state.faction && unit.faction !== state.faction) return false;
    if (state.tierFilter.size > 0 && !state.tierFilter.has(state.rows.get(unit.id)?.tier ?? 'D')) {
      return false;
    }
    if (needle && !unit.name.toLowerCase().includes(needle)) return false;
    return true;
  });

  const key = state.sortKey;
  const dir = state.sortDesc ? -1 : 1;
  rows.sort((a, b) => {
    const left = state.rows.get(a.id) as unknown as Record<string, number>;
    const right = state.rows.get(b.id) as unknown as Record<string, number>;
    const delta = (left[key] ?? 0) - (right[key] ?? 0);
    return delta * dir || a.name.localeCompare(b.name);
  });
  return rows;
}

/** Инициализация: загрузка данных и первая отрисовка. */
async function boot(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (app === null) return;
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = (await response.json()) as TierlistData;
    rebuildRows();
    render(app);
  } catch (error) {
    app.innerHTML = `<div class="empty">Не удалось загрузить данные тирлиста.<br />${String(error)}<br />
      Соберите их командой: <code>npm run build:data</code></div>`;
  }
}

const average = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Форматирование чисел для таблицы. */
const num = (value: number, digits = 1): string => value.toFixed(digits);

/** Полоса значения 0–100 для наглядности в таблице. */
function bar(value: number): string {
  const width = Math.max(0, Math.min(100, value));
  return `<span class="bar"><i style="width:${width}%"></i></span>`;
}

const SLOT_LABELS: Record<string, string> = {
  infantry: 'по пехоте',
  armor: 'по броне',
  universal: 'универсал',
};

const MODE_LABELS: Record<CombatMode, string> = {
  ranged: 'Дальний',
  melee: 'Ближний',
  combined: 'Обе фазы',
};

/** Колонки таблицы: ключ сортировки → заголовок и форматтер. */
const COLUMNS: Array<{ key: string; title: string; numeric: boolean; hint?: string }> = [
  { key: 'name', title: 'Юнит', numeric: false },
  { key: 'points', title: 'Очки', numeric: true, hint: 'Максимум 2000 для расчётов' },
  { key: 'models', title: 'Мод.', numeric: true },
  { key: 'unitType', title: 'Тип', numeric: false },
  { key: 'rawMaxDamage', title: 'Урон/100', numeric: true, hint: 'Лучший слот: урон на 100 очков' },
  { key: 'vsInfantry', title: 'Урон/100: пехота', numeric: true },
  { key: 'vsArmor', title: 'Урон/100: броня', numeric: true },
  { key: 'universal', title: 'Урон/100: универс.', numeric: true },
  { key: 'bestSlot', title: 'Слот', numeric: false },
  { key: 'takenPer100', title: 'Переж.урон', numeric: true, hint: 'Урон, принимаемый на 100 своих очков' },
  { key: 'utilityScore', title: 'Полезн.', numeric: true, hint: 'Utility, максимум 20' },
  { key: 'normDamage', title: 'Норм.урон', numeric: true },
  { key: 'normSurvivability', title: 'Норм.живуч.', numeric: true },
  { key: 'normUtility', title: 'Норм.пол.', numeric: true },
  { key: 'totalScore', title: 'TOTAL', numeric: true, hint: '0.40·урон + 0.35·живучесть + 0.25·полезность' },
  { key: 'percentile', title: 'Перц.', numeric: true },
];

/** Значение ячейки: у отредактированных юнитов берём пересчитанные метрики. */
function cellValue(unit: UnitEntry, key: string): string | number {
  const metrics = metricsOf(unit);
  switch (key) {
    case 'name':
      return unit.name;
    case 'points':
      return (state.edited.get(unit.id) ?? unit.unit).points;
    case 'models':
      return unit.models;
    case 'unitType':
      return metrics.unitType === 'Melee' ? 'Ближний' : 'Дальний';
    case 'bestSlot':
      return SLOT_LABELS[metrics.bestSlot] ?? metrics.bestSlot;
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
  const tierButtons = TIERS.map(
    (tier) =>
      `<button data-tier="${tier}" class="${state.tierFilter.has(tier) ? 'active' : ''}" title="Показать тир ${tier}">${tier}</button>`
  ).join('');

  return `
    <header>
      <h1>40K Tier List</h1>
      <p class="subtitle">
        Расчёт по правилам 11-й редакции. Клик по юниту открывает редактор характеристик —
        тир и позиция пересчитываются сразу.
      </p>
      <div class="controls">
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
      const row = state.rows.get(unit.id);
      if (row === undefined) return '';
      const edited = state.edited.has(unit.id);
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

      const tier = row.tier;
      return `<tr class="${edited ? 'edited' : ''}">
        <td>
          <span class="tier-badge" data-tier="${tier}">${tier}</span>
          <span class="unit-name" data-open="${unit.id}">${unit.name}</span>
          ${edited ? '<span class="tag edited-mark">изменён</span>' : ''}
        </td>
        ${cells}
      </tr>`;
    })
    .join('');

  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** Сводка по тирам для строки состояния. */
function renderStatus(): string {
  const units = visibleUnits();
  const counts: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const unit of units) {
    const tier = state.rows.get(unit.id)?.tier;
    if (tier) counts[tier] += 1;
  }
  const parts = TIERS.map((tier) => `${tier}:${counts[tier]}`).join('  ');
  return `${MODE_LABELS[state.mode]} · ${parts} · всего ${units.length}`;
}


/** Глубокая копия профиля: правки не должны мутировать исходные данные. */
function cloneProfile(profile: UnitProfile): UnitProfile {
  return {
    ...profile,
    keywords: [...profile.keywords],
    models: profile.models.map((model) => ({
      ...model,
      keywords: [...model.keywords],
      weapons: model.weapons.map((weapon) => ({
        ...weapon,
        attacks: weapon.attacks === null ? null : { ...weapon.attacks },
        damage: weapon.damage === null ? null : { ...weapon.damage },
        keywords: weapon.keywords.map((keyword) => ({ ...keyword })),
      })),
    })),
  };
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

/** Числовое поле редактора. */
function numberField(label: string, value: number | null, path: string, min = 0, max = 99): string {
  return `<div class="field">
    <label>${label}</label>
    <input type="number" data-path="${path}" value="${value ?? ''}" min="${min}" max="${max}" step="1" />
  </div>`;
}

/** Карточка одного оружия с полями правки. */
function weaponCard(
  weapon: UnitProfile['models'][number]['weapons'][number],
  weaponIndex: number,
  modelIndex: number,
  onlyKind: 'ranged' | 'melee'
): string {
  const active = weapon.kind === onlyKind;
  const base = `models.${modelIndex}.weapons.${weaponIndex}`;
  const fields = [
    numberField('A', weapon.attacks?.count ?? null, `${base}.attacks.count`, 0, 20),
    numberField('BS/WS', weapon.skill, `${base}.skill`, 1, 7),
    numberField('S', weapon.strength, `${base}.strength`, 1, 30),
    numberField('AP', weapon.ap, `${base}.ap`, -10, 5),
    numberField('D', weapon.damage?.count ?? null, `${base}.damage.count`, 0, 30),
  ].join('');

  return `<div class="weapon-card">
    <div class="whead">
      <span class="name">${weapon.name}</span>
      <span class="profile">${weaponProfileText(weapon)}</span>
    </div>
    <div class="field-grid" style="opacity:${active ? 1 : 0.4}">
      ${active ? fields : '<span class="profile">Не участвует в выбранном режиме боя</span>'}
    </div>
  </div>`;
}


/** Панель редактора для открытого юнита. */
function renderEditor(unit: UnitEntry): string {
  const profile = state.edited.get(unit.id) ?? cloneProfile(unit.unit);
  state.edited.set(unit.id, profile);
  const metrics = metricsOf(unit);
  const row = state.rows.get(unit.id);
  // В комбинированном режиме показываем оба типа оружия, иначе — только рабочие.
  const onlyKind: 'ranged' | 'melee' = state.mode === 'ranged' ? 'ranged' : 'melee';
  const showBoth = state.mode === 'combined';

  const model = profile.models[0];
  const modelFields = [
    numberField('Очки', profile.points, 'points', 1, CALCULATION_POINTS_LIMIT),
    numberField('T', model.toughness, 'models.0.toughness', 1, 20),
    numberField('W', model.wounds, 'models.0.wounds', 1, 40),
    numberField('Sv', model.save, 'models.0.save', 2, 7),
    numberField('InSv', model.invuln, 'models.0.invuln', 2, 7),
    `<div class="field"><label>Моделей</label><input type="number" value="${unit.models}" disabled /></div>`,
  ].join('');

  const weapons = model.weapons
    // Индекс должен оставаться ИСХОДНЫМ: путь правки адресует оригинальный
    // массив, иначе при фильтрации по типу оружия правились бы не те поля.
    .map((weapon, index) => ({ weapon, index }))
    .filter(({ weapon }) => showBoth || weapon.kind === onlyKind)
    .map(({ weapon, index }) => weaponCard(weapon, index, 0, onlyKind))
    .join('');

  const flags = (metrics.utilityFlags ?? unit.utilityFlags)
    .map((flag) => `<span class="flag" title="${flag.reason}">${flag.id} +${flag.points}</span>`)
    .join('');

  return `<div class="editor-backdrop" id="editor-backdrop">
    <div class="editor">
      <h2>${unit.name}</h2>
      <p class="hint">${unit.faction} · ${profile.points} очков · ${unit.models} моделей · ${unit.archetype}</p>

      <section>
        <h3>Показатели (${MODE_LABELS[state.mode].toLowerCase()})</h3>
        <div class="metrics">
          <div class="metric"><div class="k">Тир</div><div class="v">${row?.tier ?? '-'}</div></div>
          <div class="metric"><div class="k">Total</div><div class="v">${num(row?.totalScore ?? 0)}</div></div>
          <div class="metric"><div class="k">Перцентиль</div><div class="v">${num(row?.percentile ?? 0)}</div></div>
          <div class="metric"><div class="k">Урон/100</div><div class="v">${num(metrics.effectiveDamage, 2)}</div></div>
          <div class="metric"><div class="k">Живучесть</div><div class="v">${num(metrics.effectiveSurvivability, 2)}</div></div>
          <div class="metric"><div class="k">Переж.урон/100</div><div class="v">${num(metrics.takenPer100, 2)}</div></div>
          <div class="metric"><div class="k">Норм. урон</div><div class="v">${num(row?.normDamage ?? 0)}</div></div>
          <div class="metric"><div class="k">Норм. полезн.</div><div class="v">${num(row?.normUtility ?? 0)}</div></div>
        </div>
      </section>

      <section>
        <h3>Модель</h3>
        <div class="field-grid">${modelFields}</div>
      </section>

      <section>
        <h3>Оружие${showBoth ? '' : ` — ${MODE_LABELS[state.mode].toLowerCase()}`}</h3>
        ${weapons || '<p class="hint">В выбранном режиме у юнита нет оружия.</p>'}
      </section>

      <section>
        <h3>Небоевая полезность: ${unit.utilityScore} / 20</h3>
        <div class="flags">${flags || '<span class="flag">нет флагов</span>'}</div>
      </section>

      <div class="editor-actions">
        <button class="primary" data-action="apply">Пересчитать тир</button>
        <button data-action="reset">Сбросить правки</button>
        <button data-action="close">Закрыть</button>
      </div>
    </div>
  </div>`;
}


/** Записывает значение в профиль по пути вида `models.0.weapons.2.attacks.count`. */
function setByPath(profile: UnitProfile, path: string, raw: string): void {
  const parts = path.split('.');
  const value = raw === '' ? null : Number(raw);
  if (parts[0] === 'points') profile.points = value ?? profile.points;
  else if (parts[0] === 'models' && parts[1] !== undefined) {
    const modelIndex = Number(parts[1]);
    const model = profile.models[modelIndex];
    if (model === undefined) return;

    if (parts[2] === 'toughness') model.toughness = value ?? model.toughness;
    else if (parts[2] === 'wounds') model.wounds = value ?? model.wounds;
    else if (parts[2] === 'save') model.save = value;
    else if (parts[2] === 'invuln') model.invuln = value;
    else if (parts[2] === 'weapons' && parts[3] !== undefined) {
      const weapon = model.weapons[Number(parts[3])];
      if (weapon === undefined) return;
      if (parts[4] === 'skill') weapon.skill = value;
      else if (parts[4] === 'strength') weapon.strength = value;
      else if (parts[4] === 'ap') weapon.ap = value ?? 0;
      else if (parts[4] === 'attacks' && parts[5] === 'count') {
        weapon.attacks = weapon.attacks === null ? null : { ...weapon.attacks, count: value ?? 0 };
      } else if (parts[4] === 'damage' && parts[5] === 'count') {
        weapon.damage = weapon.damage === null ? null : { ...weapon.damage, count: value ?? 0 };
      }
    }
  }
}

/** Главная функция отрисовки: панель + таблица + редактор. */
function render(app: HTMLElement): void {
  const editor = state.openUnit === null ? '' : renderEditor(state.openUnit);
  app.innerHTML = `${renderControls()}${renderTable()}${editor}`;
  const status = document.querySelector<HTMLDivElement>('#status');
  if (status !== null) status.textContent = renderStatus();
}

/** Навешивает обработчики на элементы, созданные render(). */
function bindEvents(app: HTMLElement): void {
  app.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;

    const modeButton = target.closest<HTMLElement>('[data-mode]');
    if (modeButton?.dataset.mode) {
      state.mode = modeButton.dataset.mode as CombatMode;
      // Правки хранятся по ключу «юнит:режим» — смена режима их не теряет.
      rebuildRows();
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

    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action !== undefined && state.openUnit !== null) {
      const unit = state.openUnit;
      if (action === 'close') {
        state.openUnit = null;
      } else if (action === 'reset') {
        state.edited.delete(unit.id);
        for (const mode of state.data?.modes ?? []) state.overrides.delete(`${unit.id}:${mode}`);
      } else if (action === 'apply') {
        const profile = state.edited.get(unit.id);
        if (profile !== undefined) {
          // Пересчёт занимает доли секунды, поэтому делаем для всех режимов
          // сразу: тогда переключение режима не будет «подвисать».
          for (const mode of state.data?.modes ?? []) {
            state.overrides.set(`${unit.id}:${mode}`, recomputeMetrics(unit, profile, mode));
          }
        }
      }
      rebuildRows();
      render(app);
      return;
    }

    // Клик по фону редактора закрывает его.
    if (target.id === 'editor-backdrop') {
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
    } else if (target.dataset.path && state.openUnit !== null) {
      const profile = state.edited.get(state.openUnit.id);
      if (profile !== undefined) setByPath(profile, target.dataset.path, target.value);
    }
  });
}

const app = document.querySelector<HTMLDivElement>('#app');
if (app !== null) {
  bindEvents(app);
  void boot();
}

