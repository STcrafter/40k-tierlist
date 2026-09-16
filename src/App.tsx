// src/App.tsx

import { useEffect, useMemo, useState } from 'react';
import { loadWahapediaData, loadWahapediaFromStrings } from './data/loader';
import { UnitTransformer } from './data/transformer';
import { MOCK_DATA } from './data/mock-data';
import { WahapediaData } from './data/types/wahapedia';
import { Unit } from './data/types/unit';
import { META_TARGETS } from './core/meta/targets';
import { SimSummary } from './core/types';
import { CombatPhase } from './core/combat';
import { buildTierList } from './core/scoring/tiering';
import { analyzeUnits, } from './workers/pool';
import { UnitAnalysis } from './workers/analysis.worker';
import { TierListSection } from './components/TierListSection';

type MatrixRow = {
  unit: Unit;
  results: Map<string, SimSummary>;
};

type DataSource = 'mock' | 'real';

function App() {
  const [data, setData] = useState<WahapediaData | null>(null);
  const [allUnits, setAllUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);

  const [dataSource, setDataSource] = useState<DataSource>('mock');
  const [factionId, setFactionId] = useState<string>('');
  const [chapter, setChapter] = useState<string>('ALL');

  const [iterations, setIterations] = useState(1000);
  const [phase, setPhase] = useState<CombatPhase>('Shooting');

  const [analyses, setAnalyses] = useState<UnitAnalysis[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // === Загрузка данных ===
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      try {
        const loaded =
          dataSource === 'mock'
            ? loadWahapediaFromStrings(MOCK_DATA)
            : await loadWahapediaData(`${import.meta.env.BASE_URL}data/wahapedia`);

        const transformer = new UnitTransformer(loaded);
        const { units: transformed } = transformer.transformAll();

        if (!cancelled) {
          setData(loaded);
          setAllUnits(transformed);
          setAnalyses([]);
          setFactionId((prev) =>
            prev && loaded.factions.some((f) => f.id === prev)
              ? prev
              : loaded.factions[0]?.id ?? ''
          );
          setChapter('ALL');
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  // === Фильтры ===
  const chapterOptions = useMemo(() => {
    const factionUnits = allUnits.filter((u) => u.factionId === factionId);
    const total = factionUnits.length || 1;
    const counts = new Map<string, number>();

    for (const u of factionUnits) {
      for (const k of u.factionKeywords) {
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .filter(([, count]) => count / total < 0.6)
      .map(([keyword]) => keyword)
      .sort();
  }, [allUnits, factionId]);

  const units = useMemo(() => {
    let list = allUnits.filter((u) => u.factionId === factionId);

    if (chapter !== 'ALL' && chapterOptions.length > 0) {
      list = list.filter((u) => {
        const hasChapterKeyword = u.factionKeywords.includes(chapter);
        const isGeneric = !u.factionKeywords.some((k) => chapterOptions.includes(k));
        return hasChapterKeyword || isGeneric;
      });
    }

    return list;
  }, [allUnits, factionId, chapter, chapterOptions]);

  // === Производные данные ===
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);

  const matrixRows: MatrixRow[] = useMemo(
    () =>
      analyses
        .filter((a) => unitById.has(a.unitId))
        .map((a) => ({
          unit: unitById.get(a.unitId)!,
          results: new Map(Object.entries(a.matrices[phase])),
        })),
    [analyses, phase, unitById]
  );

  const tierEntries = useMemo(
    () =>
      analyses.length === 0
        ? []
        : buildTierList(
            analyses
              .filter((a) => unitById.has(a.unitId))
              .map((a) => ({ unit: unitById.get(a.unitId)!, metrics: a.metrics }))
          ),
    [analyses, unitById]
  );

  // === Полный анализ в воркерах ===
  const runFullAnalysis = async () => {
    setProgress({ done: 0, total: units.length });
    const start = performance.now();
    try {
      const results = await analyzeUnits(units, iterations, (done, total) =>
        setProgress({ done, total })
      );
      setAnalyses(results);
      console.log(`✅ Анализ ${results.length} юнитов: ${(performance.now() - start).toFixed(0)}ms`);
    } catch (error) {
      console.error('Analysis failed:', error);
    } finally {
      setProgress(null);
    }
  };

  const changeFaction = (id: string) => {
    setFactionId(id);
    setChapter('ALL');
    setAnalyses([]);
  };

  const changeChapter = (value: string) => {
    setChapter(value);
    setAnalyses([]);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-wh40k-darker text-white flex items-center justify-center">
        <div className="text-2xl">⚔️ Loading data...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-wh40k-darker text-white p-6">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-display text-wh40k-accent mb-6">⚔️ 40K Tier List</h1>

        {/* === Панель управления === */}
        <div className="flex items-center gap-3 mb-6 bg-wh40k-dark p-4 rounded-lg flex-wrap">
          <div className="flex gap-1 bg-black/40 rounded p-1">
            <button
              onClick={() => setDataSource('mock')}
              className={`px-3 py-1 rounded text-sm transition ${
                dataSource === 'mock' ? 'bg-wh40k-accent font-semibold' : 'text-gray-400'
              }`}
            >
              🧪 Моки
            </button>
            <button
              onClick={() => setDataSource('real')}
              className={`px-3 py-1 rounded text-sm transition ${
                dataSource === 'real' ? 'bg-wh40k-accent font-semibold' : 'text-gray-400'
              }`}
            >
              📦 Wahapedia
            </button>
          </div>

          {data && data.factions.length > 0 && (
            <select
              value={factionId}
              onChange={(e) => changeFaction(e.target.value)}
              className="bg-black/40 px-3 py-1.5 rounded text-sm max-w-xs"
            >
              {data.factions.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}

          {chapterOptions.length > 0 && (
            <select
              value={chapter}
              onChange={(e) => changeChapter(e.target.value)}
              className="bg-black/40 px-3 py-1.5 rounded text-sm max-w-xs"
            >
              <option value="ALL">Все чаптеры + базовые</option>
              {chapterOptions.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}

          <span className="text-sm text-gray-400">Юнитов: {units.length}</span>

          <div className="flex-1" />

          <label className="text-sm text-gray-400">
            Итераций:
            <input
              type="number"
              value={iterations}
              onChange={(e) => setIterations(Number(e.target.value))}
              className="ml-2 bg-black/40 px-2 py-1 rounded w-24 text-white"
              min={100}
              max={50000}
              step={100}
            />
          </label>
        </div>

        {/* === Кнопка анализа + фазы === */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <button
            onClick={runFullAnalysis}
            disabled={units.length === 0 || progress !== null}
            className="px-6 py-2 bg-wh40k-accent hover:bg-red-600 disabled:opacity-40 rounded font-semibold transition"
          >
            {progress ? `⏳ ${progress.done}/${progress.total}` : '⚡ Полный анализ'}
          </button>

          <div className="flex gap-1 bg-black/40 rounded p-1">
            {(['Shooting', 'Melee', 'All'] as CombatPhase[]).map((p) => (
              <button
                key={p}
                onClick={() => setPhase(p)}
                className={`px-3 py-1 rounded text-sm transition ${
                  phase === p ? 'bg-wh40k-accent font-semibold' : 'text-gray-400 hover:text-white'
                }`}
              >
                {p === 'Shooting' ? '🎯 Стрельба' : p === 'Melee' ? '⚔️ Ближний бой' : '🔄 Всё'}
              </button>
            ))}
          </div>
        </div>

        {/* === Прогресс-бар === */}
        {progress && (
          <div className="mb-6">
            <div className="h-2 bg-black/40 rounded overflow-hidden">
              <div
                className="h-full bg-wh40k-gold transition-all duration-150"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* === Матрица урона === */}
        {matrixRows.length > 0 && (
          <div className="overflow-x-auto mb-8">
            <table className="w-full bg-wh40k-dark rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-black/40">
                  <th className="text-left p-3 sticky left-0 bg-black/40">Юнит</th>
                  {META_TARGETS.map((t) => (
                    <th key={t.id} className="p-2 text-xs font-normal">
                      <div className="text-wh40k-gold">{t.name}</div>
                      <div className="text-gray-500">вес: {(t.metaWeight * 100).toFixed(0)}%</div>
                    </th>
                  ))}
                  <th className="p-3 bg-wh40k-accent/20">
                    DPE ({phase === 'Shooting' ? 'shoot' : phase === 'Melee' ? 'melee' : 'all'})
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrixRows.map((row) => (
                  <tr key={row.unit.id} className="border-t border-gray-800">
                    <td className="p-3 sticky left-0 bg-wh40k-dark">
                      <div className="font-semibold">{row.unit.name}</div>
                      <div className="text-xs text-gray-400">
                        {row.unit.points}pts · {row.unit.models}×
                      </div>
                    </td>
                    {META_TARGETS.map((t) => {
                      const res = row.results.get(t.id);
                      return res ? <DamageCell key={t.id} result={res} /> : <td key={t.id} />;
                    })}
                    <td className="p-3 bg-wh40k-accent/10 font-bold text-center">
                      {calculateWeightedDPE(row).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* === Тир-лист === */}
        {tierEntries.length > 0 && <TierListSection entries={tierEntries} />}
      </div>
    </div>
  );
}

function DamageCell({ result }: { result: SimSummary }) {
  return (
    <td className="p-2 text-center">
      <div className={`font-bold ${getDamageColor(result.mean)}`}>{result.mean.toFixed(1)}</div>
      <div className="text-[10px] text-gray-500">
        [{result.percentiles.p10}–{result.percentiles.p90}]
      </div>
      <div className="text-[10px] text-yellow-600">
        {(result.probabilityOfKill * 100).toFixed(0)}% kill
      </div>
    </td>
  );
}

function getDamageColor(damage: number): string {
  if (damage >= 8) return 'text-green-400';
  if (damage >= 5) return 'text-yellow-400';
  if (damage >= 2) return 'text-orange-400';
  return 'text-red-400';
}

function calculateWeightedDPE(row: MatrixRow): number {
  if (!row.unit.points) return 0;
  let weighted = 0;
  for (const target of META_TARGETS) {
    const res = row.results.get(target.id);
    if (res) weighted += res.mean * target.metaWeight;
  }
  return (weighted / row.unit.points) * 100;
}

export default App;