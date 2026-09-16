// src/components/TierListSection.tsx

import { TierEntry, Tier } from '../core/scoring/tiering';

const TIER_STYLES: Record<Tier, string> = {
  S: 'from-amber-500 to-yellow-400',
  A: 'from-green-600 to-green-400',
  B: 'from-blue-600 to-blue-400',
  C: 'from-orange-600 to-orange-400',
  D: 'from-red-700 to-red-500',
};

export function TierListSection({ entries }: { entries: TierEntry[] }) {
  const tiers = [Tier.S, Tier.A, Tier.B, Tier.C, Tier.D];

  return (
    <div className="mt-10 space-y-4">
      <h2 className="text-3xl font-display text-wh40k-gold">🏆 Tier List</h2>

      {tiers.map((tier) => {
        const items = entries.filter((e) => e.tier === tier);
        if (items.length === 0) return null;

        return (
          <div key={tier} className="flex gap-3">
            <div
              className={`w-14 flex-shrink-0 rounded bg-gradient-to-b ${TIER_STYLES[tier]} 
                flex items-center justify-center text-3xl font-bold text-black shadow-lg`}
            >
              {tier}
            </div>
            <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map((e) => (
                <TierCard key={e.unit.id} entry={e} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TierCard({ entry }: { entry: TierEntry }) {
  const { unit, axis, composite, metrics, strengths, weaknesses } = entry;

  return (
    <div className="bg-wh40k-dark rounded p-3 border border-gray-700">
      <div className="flex justify-between items-center">
        <span className="font-semibold">{unit.name}</span>
        <span className="text-wh40k-gold font-bold text-lg">
          {composite.toFixed(0)}
        </span>
      </div>

      <div className="text-xs text-gray-400 mb-2">
        {unit.category} · {unit.points}pts · DPE: sh {metrics.dpeShoot.toFixed(1)} / ml{' '}
        {metrics.dpeMelee.toFixed(1)} · TTK {metrics.spe.toFixed(1)}
      </div>

      <div className="space-y-1">
        <Bar label="DMG" value={axis.dpe} color="bg-red-500" />
        <Bar label="SUR" value={axis.spe} color="bg-blue-500" />
        <Bar label="OBJ" value={axis.ope} color="bg-green-500" />
      </div>

      {(strengths.length > 0 || weaknesses.length > 0) && (
        <div className="mt-2 text-xs leading-relaxed">
          {strengths.map((s) => (
            <span key={s} className="text-green-400 mr-2">+ {s}</span>
          ))}
          {weaknesses.map((w) => (
            <span key={w} className="text-red-400 mr-2">− {w}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-7 text-gray-400">{label}</span>
      <div className="flex-1 h-1.5 bg-black/40 rounded overflow-hidden">
        <div className={`h-full rounded ${color}`} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[10px] w-6 text-right text-gray-400">
        {value.toFixed(0)}
      </span>
    </div>
  );
}