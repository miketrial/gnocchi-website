/* Test a bear-defense overlay: does adding a market filter (only buy when SPY is
   in an uptrend, i.e. regime=="bull") to the best combo improve the outcome —
   especially removing the bad "buy into a decline" entries? Loads the compact
   entry dump for speed. Entry fields:
   [0 sym,1 d,2 ts,3 TREND,4 MOM,5 EXT,6 VOL,7 SECRS,8 dv,9 beta,10 atrPct,11 offHigh,
    12 vix,13 pnl,14 edge,15 betaEdge,16 regime,17 crisis,18 oos] */
import { readFileSync } from "node:fs";
const E = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/deep-entries.json", import.meta.url), "utf8"));
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const G = a => ({ n: a.length, edge: r2(mean(a.map(e => e[14]))), be: r2(mean(a.map(e => e[15]).filter(v => v != null))), pnl: r2(mean(a.map(e => e[13]))), win: r2(100 * a.filter(e => e[13] > 0).length / (a.length || 1)), worst: a.length ? r2(Math.min(...a.map(e => e[13]))) : null });

const combo = e => e[2] >= 14 && e[8] >= 1e9 && e[7] >= 2;     // techScore>=14 & $1B & SECRS>=2
const bull = e => e[16] === "bull";                            // SPY > 200DMA at entry

const base = E.filter(combo);
const withFilter = E.filter(e => combo(e) && bull(e));
const removed = E.filter(e => combo(e) && !bull(e));           // what the market filter drops

console.log("=== Best combo: techScore>=14 & $1B & SECRS>=2 ===");
const show = (lbl, a) => { const s = G(a); console.log(`${lbl}\tn=${s.n}\tedge=${s.edge}\tbetaAdj=${s.be}\tavgPnl=${s.pnl}\twin=${s.win}%\tworst=${s.worst}`); };
show("WITHOUT market filter (all regimes)", base);
show("WITH SPY>200DMA filter            ", withFilter);
show("  -> DROPPED (bear-regime entries) ", removed);

console.log("\n=== IS / OOS with the market filter ===");
show("WITH filter, IS(<2017)", withFilter.filter(e => !e[18]));
show("WITH filter, OOS(>=2017)", withFilter.filter(e => e[18]));

console.log("\n=== Per-crisis: what the combo did entering DURING each bear (and what the filter removes) ===");
const CR = ["GFC", "euro11", "sino16", "q4-18", "covid", "bear22"];
console.log("crisis\tcombo_n\tcombo_edge\tcombo_worst  (all of these are DROPPED by SPY>200DMA if regime=bear)");
for (const cr of CR) { const a = base.filter(e => e[17] === cr); if (!a.length) { console.log(`${cr}\t0`); continue; } const s = G(a); console.log(`${cr}\t${s.n}\t${s.edge}\t${s.worst}`); }

console.log("\n=== Portfolio-style: equity max drawdown, combo WITH vs WITHOUT filter ===");
function maxDD(entries) {
  const trades = entries.map(e => ({ d: e[1], pnl: e[13] })).sort((a, b) => (a.d < b.d ? -1 : 1));
  let eq = 1, peak = 1, mdd = 0;
  for (const t of trades) { eq *= (1 + (t.pnl / 100) / 8); if (eq > peak) peak = eq; const dd = (eq - peak) / peak; if (dd < mdd) mdd = dd; }
  return r2(mdd * 100);
}
console.log(`WITHOUT filter: sequential 1/8-weighted equity maxDD = ${maxDD(base)}%`);
console.log(`WITH filter   : sequential 1/8-weighted equity maxDD = ${maxDD(withFilter)}%`);
console.log("(rough compounding proxy — same trades in date order, 1/8 position each)");
