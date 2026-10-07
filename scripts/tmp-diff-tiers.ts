import { readFileSync } from 'node:fs';

const before = JSON.parse(readFileSync('C:/Users/user/AppData/Local/Temp/opencode/tierlist-before.json', 'utf8'));
const after = JSON.parse(readFileSync('C:/Projects/40k-tierlist/web/public/data/tierlist.json', 'utf8'));

/** Все ячейки (парадигма → режим) одного юнита плоским списком. */
const cellsOf = (row) => Object.entries(row.cells ?? {}).flatMap(([paradigm, modes]) =>
  Object.entries(modes).map(([mode, cell]) => ({ paradigm, mode, ...cell }))
);

const byId = (data) => new Map(data.units.map((u) => [u.id, u]));
const a = byId(before);
const b = byId(after);

let compared = 0;
const tierMoves = [];
const scoreMoves = [];
const utilityMoves = [];
const flagChanges = [];

for (const [id, beforeRow] of a) {
  const afterRow = b.get(id);
  if (!afterRow) continue;

  const beforeFlags = (beforeRow.utilityFlags ?? []).map((f) => f.id).sort().join(',');
  const afterFlags = (afterRow.utilityFlags ?? []).map((f) => f.id).sort().join(',');
  if (beforeFlags !== afterFlags) {
    const beforeSet = new Set(beforeFlags.split(','));
    const afterSet = new Set(afterFlags.split(','));
    const removed = [...beforeSet].filter((f) => !afterSet.has(f));
    const added = [...afterSet].filter((f) => !beforeSet.has(f));
    flagChanges.push(`${beforeRow.name} [${id}]: −${removed.join(',') || '—'} +${added.join(',') || '—'}`);
  }

  const afterCells = new Map(cellsOf(afterRow).map((c) => [`${c.paradigm}/${c.mode}`, c]));
  for (const beforeCell of cellsOf(beforeRow)) {
    const afterCell = afterCells.get(`${beforeCell.paradigm}/${beforeCell.mode}`);
    if (!afterCell) continue;
    compared += 1;
    const key = `${beforeRow.name} [${beforeCell.paradigm}/${beforeCell.mode}]`;
    if (beforeCell.tier !== afterCell.tier) tierMoves.push(`${key}: ${beforeCell.tier}→${afterCell.tier}`);
    const ds = afterCell.totalScore - beforeCell.totalScore;
    if (Math.abs(ds) > 0.000001) scoreMoves.push(`${key}: ${beforeCell.totalScore.toFixed(3)}→${afterCell.totalScore.toFixed(3)}`);
    const du = (afterCell.utilityScore ?? 0) - (beforeCell.utilityScore ?? 0);
    if (du !== 0) utilityMoves.push(`${key}: utility ${beforeCell.utilityScore}→${afterCell.utilityScore}`);
  }
}

console.log(`сравнено ячеек: ${compared}`);
console.log(`\nСМЕНА ТИРА: ${tierMoves.length}`);
console.log(tierMoves.slice(0, 40).join('\n') || '—');
console.log(`\nСМЕНА ОЦЕНКИ: ${scoreMoves.length}`);
console.log(scoreMoves.slice(0, 25).join('\n') || '—');
console.log(`\nСМЕНА ПОЛЕЗНОСТИ: ${utilityMoves.length}`);
console.log(utilityMoves.slice(0, 25).join('\n') || '—');
console.log(`\nСМЕНА ФЛАГОВ: ${flagChanges.length}`);
console.log(flagChanges.join('\n') || '—');