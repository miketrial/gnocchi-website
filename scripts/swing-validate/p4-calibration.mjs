/* ===== P4 — strategy calibration (entry / exits / long-vs-short), re-decided on
   the corrected universe. Deterministic, off-cache. Emits p4-calibration.json.
   Incumbent live rule = 4×ATR stop + 50/200 death-cross + 63d time cap  ≙ the
   grid's `maCross_atr40`. We re-rank the whole grid IS/OOS/net, sweep the entry
   bar (uptrend gate on/off), and re-test the long-only decision with the
   reachable delisted pool included. */
import {
  loadSurvivorCache, loadPitCache, labelUniverse, splitByDate, walkForwardFolds,
  aggregateShortRule, aggregateNet, shortExitGridReport, swingExitGrid,
  simulateShortExit, portfolioSim, fwdReturnPct, mean, winRate, median, round, COST_BAND_BPS,
} from "./lib.mjs";
import { writeFileSync } from "node:fs";

// Extended exit grid: the incumbent family at finer ATR + time granularity, plus
// the canonical trend-follow alternatives, so the 4×ATR/deathcross/63d choice is
// tested against its neighbours (plateau, not peak).
function extendedGrid() {
  const g = [...swingExitGrid()];
  for (const atr of [3.0, 3.5, 4.0, 4.5, 5.0]) g.push({ label: `maCross_atr${atr * 10}`, target: "maCross", timeStop: 63, initStopAtr: atr });
  for (const t of [40, 63, 84]) g.push({ label: `maCross_t${t}`, target: "maCross", timeStop: t, initStopAtr: 4.0 });
  // de-dup by label
  const seen = new Set(); return g.filter(r => (seen.has(r.label) ? false : seen.add(r.label)));
}
const INCUMBENT = "maCross_atr40"; // 4×ATR + death-cross + 63d

function gridReport(records, spyHist, costBps = 10) {
  const grid = extendedGrid();
  const { IS, OOS } = splitByDate(records);
  const rows = grid.map(rule => {
    const full = aggregateShortRule(records, rule, spyHist);
    const net = aggregateNet(records, rule, spyHist, costBps);
    const is = aggregateShortRule(IS, rule, spyHist);
    const oos = aggregateShortRule(OOS, rule, spyHist);
    const wf = walkForwardFolds(records, 4).map(f => round(aggregateShortRule(f.test, rule, spyHist).expectancy));
    return {
      rule: rule.label, n: full.n,
      exp: round(full.expectancy), net: round(net.netExpectancy), edge: round(full.edge),
      win: round(full.winRate, 3), pf: round(full.profitFactor), worst: round(full.worst),
      expPerDay: round(full.expPerDay, 3), avgHold: round(full.avgHold, 1),
      isExp: round(is.expectancy), oosExp: round(oos.expectancy), wfExp: wf,
    };
  });
  return rows.sort((a, b) => (b.exp ?? -1e9) - (a.exp ?? -1e9));
}

// Entry-bar sweep with the uptrend gate on/off. Uptrend ⟺ Trend factor buy≥2
// (fTrend: buy≥2 requires price>50DMA>200DMA), matching the LIVE entryStrong gate
// that the study's labelShortTicker does NOT itself apply.
function entrySweep(cache, spyHist) {
  const out = [];
  for (const longTh of [10, 11, 12, 13, 14]) {
    const { records } = labelUniverse(cache, { bidirectional: false, longTh });
    for (const gate of [false, true]) {
      const recs = gate ? records.filter(r => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2) : records;
      const raw = recs.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
      const inc = swingExitGrid().find(x => x.label === INCUMBENT);
      const agg = aggregateShortRule(recs, inc, spyHist);
      const { IS, OOS } = splitByDate(recs);
      out.push({
        longTh, uptrendGate: gate, n: recs.length,
        rawFwd21: round(mean(raw)), rawWin: round(winRate(raw), 3),
        incExp: round(agg.expectancy), incEdge: round(agg.edge), incWorst: round(agg.worst),
        incOOS: round(aggregateShortRule(OOS, inc, spyHist).expectancy),
      });
    }
  }
  return out;
}

// Long vs short vs bidirectional on a cache (raw fwd + best-rule expectancy).
function directional(cache, spyHist, label) {
  const { records } = labelUniverse(cache, { bidirectional: true });
  const longs = records.filter(r => r.side === "long");
  const shorts = records.filter(r => r.side === "short");
  const raw = (recs) => { const a = recs.map(r => fwdReturnPct(r, 21)).filter(x => x != null); return { n: a.length, avg: round(mean(a)), win: round(winRate(a), 3) }; };
  const bestRule = (recs) => recs.length >= 20 ? shortExitGridReport(recs, spyHist)[0] : null;
  const bl = bestRule(longs), bs = bestRule(shorts), bb = bestRule(records);
  return {
    label,
    rawLong: raw(longs), rawShort: raw(shorts),
    bestLong: bl && { rule: bl.rule, exp: round(bl.expectancy), edge: round(bl.edge), worst: round(bl.worst), pf: round(bl.profitFactor) },
    bestShort: bs && { rule: bs.rule, exp: round(bs.expectancy), edge: round(bs.edge), worst: round(bs.worst), pf: round(bs.profitFactor) },
    bestBidir: bb && { rule: bb.rule, exp: round(bb.expectancy), edge: round(bb.edge), worst: round(bb.worst), pf: round(bb.profitFactor) },
  };
}

function main() {
  const survivor = loadSurvivorCache();
  const pit = loadPitCache();
  const { records: sRecs } = labelUniverse(survivor, { bidirectional: false });

  const result = {
    incumbent: INCUMBENT,
    costBand: COST_BAND_BPS,
    grid: gridReport(sRecs, survivor.spyHist),
    entrySweep: entrySweep(survivor, survivor.spyHist),
    directional: { survivor: directional(survivor, survivor.spyHist, "survivors-only") },
    portfolio: {},
    survivorshipGap: null,
  };
  if (pit) {
    result.directional.pit = directional(pit, pit.spyHist, "survivors+delisted (PIT)");
    // survivorship gap: same best long rule, survivors-only vs survivors+delisted.
    const { records: pRecs } = labelUniverse(pit, { bidirectional: false, membershipGate: true });
    const inc = swingExitGrid().find(x => x.label === INCUMBENT);
    const sAgg = aggregateShortRule(sRecs, inc, survivor.spyHist);
    const pAgg = aggregateShortRule(pRecs, inc, pit.spyHist);
    result.survivorshipGap = {
      rule: INCUMBENT,
      survivorsOnly: { n: sAgg.n, exp: round(sAgg.expectancy), worst: round(sAgg.worst), edge: round(sAgg.edge) },
      withDelisted: { n: pAgg.n, exp: round(pAgg.expectancy), worst: round(pAgg.worst), edge: round(pAgg.edge) },
      expectancyGap: round((sAgg.expectancy ?? 0) - (pAgg.expectancy ?? 0)),
      worstGap: round((sAgg.worst ?? 0) - (pAgg.worst ?? 0)),
      delistedNames: pit.delistedCount,
    };
  }
  // Portfolio sim: incumbent vs hold63 vs best-by-net.
  const rules = swingExitGrid();
  for (const label of [INCUMBENT, "hold63", "maCross"]) {
    const rule = rules.find(r => r.label === label);
    if (rule) result.portfolio[label] = (() => { const p = portfolioSim(sRecs, rule, { maxPositions: 8, perSectorMax: 3, costBps: 10 });
      return { cagr: round(p.cagr), sharpe: round(p.sharpePerTrade, 3), sortino: round(p.sortinoPerTrade, 3), maxDD: round(p.maxDDpct), taken: p.taken, exposure: round(p.exposureFrac, 2), years: p.years }; })();
  }

  writeFileSync(new URL("../../scratchpad/swing-validate/p4-calibration.json", import.meta.url), JSON.stringify(result, null, 2));

  // ---- console summary ----
  console.log(`\n── P4 exit grid — survivors-only (ranked by expectancy; incumbent=${INCUMBENT}) ──`);
  console.log("rule            n     exp    net   edge   win   pf    worst   IS/OOS         wf-folds");
  for (const r of result.grid.slice(0, 12)) {
    const mark = r.rule === INCUMBENT ? " ◀INCUMBENT" : "";
    console.log(`${r.rule.padEnd(14)} ${String(r.n).padStart(4)} ${String(r.exp).padStart(6)} ${String(r.net).padStart(6)} ${String(r.edge).padStart(6)} ${String(r.win).padStart(5)} ${String(r.pf).padStart(5)} ${String(r.worst).padStart(7)}  ${String(r.isExp)}/${String(r.oosExp)}  [${r.wfExp.join(",")}]${mark}`);
  }
  const incRow = result.grid.find(r => r.rule === INCUMBENT);
  console.log(`  incumbent rank by expectancy: ${result.grid.findIndex(r => r.rule === INCUMBENT) + 1}/${result.grid.length}  (exp ${incRow.exp}%, net ${incRow.net}%, worst ${incRow.worst}%, OOS ${incRow.oosExp}%)`);

  console.log(`\n── entry-bar sweep (fwd-21d + incumbent-rule exp) ──`);
  console.log("bar  gate   n     rawFwd  incExp  incEdge  incWorst  incOOS");
  for (const e of result.entrySweep) console.log(`${String(e.longTh).padStart(3)}  ${e.uptrendGate ? "up " : "off"}  ${String(e.n).padStart(5)}  ${String(e.rawFwd21).padStart(6)}  ${String(e.incExp).padStart(6)}  ${String(e.incEdge).padStart(6)}  ${String(e.incWorst).padStart(7)}  ${String(e.incOOS).padStart(6)}`);

  console.log(`\n── long vs short vs bidir ──`);
  for (const key of Object.keys(result.directional)) {
    const d = result.directional[key];
    console.log(`  ${d.label}:`);
    console.log(`    raw fwd21  long ${d.rawLong.avg}% (n${d.rawLong.n}, win ${d.rawLong.win})   short ${d.rawShort.avg}% (n${d.rawShort.n}, win ${d.rawShort.win})`);
    if (d.bestLong) console.log(`    best long  ${d.bestLong.rule} exp ${d.bestLong.exp}% edge ${d.bestLong.edge} worst ${d.bestLong.worst}`);
    if (d.bestShort) console.log(`    best short ${d.bestShort.rule} exp ${d.bestShort.exp}% edge ${d.bestShort.edge} worst ${d.bestShort.worst}`);
    if (d.bestBidir) console.log(`    best bidir ${d.bestBidir.rule} exp ${d.bestBidir.exp}% edge ${d.bestBidir.edge} worst ${d.bestBidir.worst}`);
  }
  if (result.survivorshipGap) {
    const g = result.survivorshipGap;
    console.log(`\n── survivorship gap (${g.rule}) ──`);
    console.log(`  survivors-only   exp ${g.survivorsOnly.exp}%  worst ${g.survivorsOnly.worst}%  (n${g.survivorsOnly.n})`);
    console.log(`  +delisted (${g.delistedNames})   exp ${g.withDelisted.exp}%  worst ${g.withDelisted.worst}%  (n${g.withDelisted.n})`);
    console.log(`  → expectancy gap ${g.expectancyGap}pp   worst-trade gap ${g.worstGap}pp`);
  }
  console.log(`\n── portfolio sim (8 pos, 3/sector, 10bps) ──`);
  for (const k of Object.keys(result.portfolio)) { const p = result.portfolio[k]; console.log(`  ${k.padEnd(14)} CAGR ${p.cagr}%  Sharpe ${p.sharpe}  maxDD ${p.maxDD}%  taken ${p.taken}  exposure ${p.exposure}  (${p.years}y)`); }
  console.log(`\nP4 → scratchpad/swing-validate/p4-calibration.json`);
}
main();
