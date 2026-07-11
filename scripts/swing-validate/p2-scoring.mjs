/* ===== P2 — scoring validation (the 6 reconstructable factors + the aggregate)
   Deterministic, off-cache. Reuses the LIVE labelShortTicker so entries/factors
   are byte-identical to the screener. Emits scratchpad/swing-validate/p2-scoring.json.

   Confidence tiers (per plan §P2):
     - HIGH: the 6 EOD-computable factors — full historical attribution here.
     - LOW/NA: the 5 fundamental factors (analyst/valuation/quality/leverage/
       catalyst) CANNOT be reconstructed point-in-time from EOD history, so they
       are NOT attributable offline. Reported as a first-class limitation, not
       silently scored. */
import {
  loadSurvivorCache, loadPitCache, labelUniverse, splitByDate, fwdReturnPct,
  pearson, spearman, mean, winRate, buildRegimeContext, regimeOf, round, FACTOR_KEYS,
} from "./lib.mjs";
import { writeFileSync } from "node:fs";

const HORIZONS = [10, 21, 63];
const FACTOR_LABEL = { TREND: "Trend", MOM: "3M-Momentum", EXTREME: "Near-High", LIQ: "Liquidity", VOL: "Volume-Surge", SECRS: "Sector-RS" };

function ptsOf(rec, key) {
  const f = rec.factors.find(ff => ff.key === key);
  if (!f) return null;
  return rec.side === "short" ? f.sell : f.buy;
}

// Per-factor attribution at one horizon over a record set.
function attribution(records, key, H) {
  const xs = [], ys = [], buckets = { 0: [], 1: [], 2: [], 3: [] };
  for (const rec of records) {
    const p = ptsOf(rec, key), r = fwdReturnPct(rec, H);
    if (p == null || r == null) continue;
    xs.push(p); ys.push(r);
    buckets[Math.max(0, Math.min(3, Math.round(p)))].push(r);
  }
  const b = k => ({ n: buckets[k].length, avgRet: round(mean(buckets[k])), win: round(winRate(buckets[k]), 3) });
  const b0 = mean(buckets[0]), b3 = mean(buckets[3]);
  return {
    n: xs.length, ic: round(pearson(xs, ys), 4), spearman: round(spearman(xs, ys), 4),
    monotonic: (b0 != null && b3 != null) ? b3 > b0 : null,
    topMinusBottom: (b0 != null && b3 != null) ? round(b3 - b0) : null,
    buckets: { 0: b(0), 1: b(1), 2: b(2), 3: b(3) },
  };
}

// Factor-to-factor correlation (redundancy map) using the entry-side points.
function redundancy(records) {
  const M = {};
  for (const a of FACTOR_KEYS) {
    M[a] = {};
    for (const b of FACTOR_KEYS) {
      const xs = [], ys = [];
      for (const rec of records) {
        const pa = ptsOf(rec, a), pb = ptsOf(rec, b);
        if (pa == null || pb == null) continue;
        xs.push(pa); ys.push(pb);
      }
      M[a][b] = round(pearson(xs, ys), 3);
    }
  }
  return M;
}

// Aggregate 0-18 core score → decile-ish forward returns + a "strong (≥bar)"
// classifier separation (precision/recall vs beating the median forward return).
function aggregateReport(records, H, bar) {
  const withRet = records.map(r => ({ score: r.buyScore, ret: fwdReturnPct(r, H) })).filter(x => x.ret != null);
  const byScore = {};
  for (const x of withRet) (byScore[x.score] ||= []).push(x.ret);
  const scoreTable = Object.keys(byScore).map(Number).sort((a, b) => a - b)
    .map(s => ({ score: s, n: byScore[s].length, avgRet: round(mean(byScore[s])), win: round(winRate(byScore[s]), 3) }));
  // classifier: "strong" = score>=bar. Positive class = forward return > 0.
  const strong = withRet.filter(x => x.score >= bar), weak = withRet.filter(x => x.score < bar);
  return {
    bar,
    scoreTable,
    strong: { n: strong.length, avgRet: round(mean(strong.map(x => x.ret))), win: round(winRate(strong.map(x => x.ret)), 3) },
    weak: { n: weak.length, avgRet: round(mean(weak.map(x => x.ret))), win: round(winRate(weak.map(x => x.ret)), 3) },
    lift: round(mean(strong.map(x => x.ret)) - mean(weak.map(x => x.ret))),
  };
}

// Entry-bar threshold sweep: expectancy of the raw fwd-H return by min core score.
function barSweep(records, H, bars = [10, 11, 12, 13, 14]) {
  return bars.map(bar => {
    const rets = records.filter(r => r.buyScore >= bar).map(r => fwdReturnPct(r, H)).filter(x => x != null);
    return { bar, n: rets.length, avgRet: round(mean(rets)), win: round(winRate(rets), 3) };
  });
}

function analyzeSet(records, label) {
  const { IS, OOS } = splitByDate(records);
  const out = { label, n: records.length, factors: {}, redundancy: redundancy(records), aggregate: {}, barSweep: {} };
  for (const key of FACTOR_KEYS) {
    out.factors[key] = { label: FACTOR_LABEL[key] };
    for (const H of HORIZONS) out.factors[key][`h${H}`] = attribution(records, key, H);
    // OOS stability of the headline IC (fwd-21d)
    out.factors[key].icOOS21 = attribution(OOS, key, 21).ic;
    out.factors[key].icIS21 = attribution(IS, key, 21).ic;
  }
  for (const H of HORIZONS) out.aggregate[`h${H}`] = aggregateReport(records, H, 12);
  for (const H of HORIZONS) out.barSweep[`h${H}`] = barSweep(records, H);
  return out;
}

function main() {
  const survivor = loadSurvivorCache();
  const pit = loadPitCache();
  const { records: sRecs } = labelUniverse(survivor, { bidirectional: false });
  const result = { generatedFrom: "short-study-cache.json + pit-cache.json", horizons: HORIZONS, survivor: analyzeSet(sRecs, "survivors-only") };

  if (pit) {
    const { records: pRecs } = labelUniverse(pit, { bidirectional: false, membershipGate: true });
    result.pit = analyzeSet(pRecs, "survivors+delisted (PIT)");
    result.pitDelistedCount = pit.delistedCount;
  }

  // Fundamentals: explicit non-reconstructability note.
  result.fundamentals = {
    factors: ["AnalystRevisions", "Valuation", "Quality", "Leverage", "Catalyst"],
    reconstructable: false,
    note: "These 5 factors need point-in-time fundamentals (analyst PT/rating snapshots, fwd EPS, quarterly FCF/ROE/debt, earnings calendar) dated at each past bar. EOD price history cannot reconstruct them, so they are NOT attributable from this cache. Triangulation (current-snapshot proxy / live forward log / dated-fundamental PIT) requires live scoring + the short-trades blob and is out of scope for the offline cache. Confidence: the 33-pt aggregate's predictive power measured here reflects only its 6-factor technical core.",
  };

  writeFileSync(new URL("../../scratchpad/swing-validate/p2-scoring.json", import.meta.url), JSON.stringify(result, null, 2));

  // ---- console summary ----
  const line = (k, f) => {
    const h = f[`h21`];
    console.log(`  ${FACTOR_LABEL[k].padEnd(13)} IC21 ${String(round(h.ic,3)).padStart(7)}  Sp ${String(round(h.spearman,3)).padStart(7)}  mono ${String(h.monotonic).padStart(5)}  top-bot ${String(h.topMinusBottom).padStart(6)}  IS/OOS ${round(f.icIS21,3)}/${round(f.icOOS21,3)}`);
  };
  for (const setKey of ["survivor", "pit"]) {
    const s = result[setKey]; if (!s) continue;
    console.log(`\n── P2 factor attribution — ${s.label} (n=${s.n}, fwd-21d) ──`);
    for (const k of FACTOR_KEYS) line(k, s.factors[k]);
    console.log(`  aggregate ≥12/18 core: strong avg ${s.aggregate.h21.strong.avgRet}% (n=${s.aggregate.h21.strong.n}) vs weak ${s.aggregate.h21.weak.avgRet}% → lift ${s.aggregate.h21.lift}pp`);
    console.log(`  entry-bar sweep (fwd-21d): ` + s.barSweep.h21.map(b => `${b.bar}:${b.avgRet}%(${b.n})`).join("  "));
  }
  console.log(`\nfundamentals: NOT reconstructable offline (see json).`);
  console.log(`\nP2 → scratchpad/swing-validate/p2-scoring.json`);
}
main();
