/* ===== #1 — validate the 5 fundamental factors ================================
   Two methods:
     A) DATED point-in-time (the honest test) for the reconstructable factors —
        reconstruct each factor's 0-3 points AS OF each entry bar D using only data
        public by D (acceptedDate/date ≤ D), then IC vs forward return + the BLOCK's
        incremental lift over the technical-score entry population.
        · Quality, Leverage → reuse the LIVE check ladders (checkQuality/checkLeverage)
          fed PIT-filtered statements (byte-identical ladder).
        · Catalyst, Analyst-rating-drift → re-implemented as-of-D (the live ones use
          Date.now, so they can't score a past date directly).
     B) Valuation (fwd P/E): the forward-EPS-estimate VINTAGE as-of D is not datable
        (analyst-estimates gives current estimates by period), so it is reported as
        NOT-PIT-ASSESSABLE, not silently scored.
   Entries = the equal-weight technical study population (labelUniverse), so the
   fundamental IC is measured on the same bars the score actually fires.
   Usage: node scripts/swing-validate/p8-fundamentals.mjs */
import {
  loadSurvivorCache, labelUniverse, fwdReturnPct, pearson, spearman, mean, winRate, round,
} from "./lib.mjs";
import { checkQuality, checkLeverage } from "../../netlify/lib/short-pipeline.mjs";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const FUND = new URL("../../scratchpad/swing-validate/fundamentals-cache.json", import.meta.url);
if (!existsSync(FUND)) { console.error("fundamentals-cache.json not built yet — run fundamentals-pull.mjs"); process.exit(1); }
const fund = JSON.parse(readFileSync(FUND, "utf8"));

const asOf = (row) => row?.acceptedDate?.slice(0, 10) || row?.filingDate?.slice(0, 10) || row?.date?.slice(0, 10) || null;
const beforeD = (rows, D) => (rows || []).filter(r => { const a = asOf(r); return a && a <= D; }).sort((x, y) => (asOf(y) || "").localeCompare(asOf(x) || "")); // newest-first, public by D

// ---- PIT factor reconstructions ----
function qualityPtsPIT(f, D, industry) {
  const cf = beforeD(f.cf, D).slice(0, 4);                       // last 4 public quarters
  const inc = beforeD(f.inc, D).slice(0, 4);
  const bs = beforeD(f.bs, D).slice(0, 1);
  if (cf.length < 4 || !bs.length || inc.length < 4) return null;
  const ttmNI = inc.reduce((s, q) => s + (q.netIncome ?? 0), 0);
  const equity = bs[0].totalStockholdersEquity ?? bs[0].totalEquity ?? null;
  const roe = equity && equity !== 0 ? ttmNI / equity : null;
  if (roe == null) return null;
  return checkQuality(cf, [{ returnOnEquity: roe }], industry).points; // reuse live ladder
}
function leveragePtsPIT(f, D) {
  const bs = beforeD(f.bs, D).slice(0, 1);
  const inc = beforeD(f.inc, D).slice(0, 4);
  if (!bs.length || inc.length < 4) return null;
  return checkLeverage(bs, inc).points;                         // reuse live ladder
}
function catalystPtsPIT(f, D) {
  const e = (f.earnings || []).filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date));
  const future = e.filter(r => r.date > D);                     // future AS OF D
  const next = future[0];
  if (!next) return null;
  const daysUntil = Math.ceil((Date.parse(next.date) - Date.parse(D)) / 86400000);
  if (daysUntil < 7) return 0;
  if (daysUntil > 90) return 0;
  const past = e.filter(r => r.date <= D && r.epsActual != null && r.epsEstimated != null).slice(-4);
  const beats = past.filter(r => r.epsActual > r.epsEstimated).length, total = past.length;
  if (total === 0) return 1;
  if (beats >= 3) return 3;
  if (beats >= 1) return 2;
  return 1;
}
function buyRatio(row) {
  if (!row) return null;
  const sb = row.analystRatingsStrongBuy ?? 0, b = row.analystRatingsBuy ?? 0, h = row.analystRatingsHold ?? 0, se = row.analystRatingsSell ?? 0, ss = row.analystRatingsStrongSell ?? 0;
  const tot = sb + b + h + se + ss; return tot > 0 ? (sb + b) / tot : null;
}
function analystPtsPIT(f, D) {                                   // rating-drift-only PIT proxy (PT vintage not datable)
  const g = (f.grades || []).filter(r => r.date && r.date <= D).sort((a, b) => b.date.localeCompare(a.date));
  if (!g.length) return null;
  const brNow = buyRatio(g[0]);
  const cutoff = new Date(Date.parse(D) - 60 * 86400000).toISOString().slice(0, 10);
  let thenRow = g.find(r => r.date <= cutoff) || (g.length >= 2 ? g[g.length - 1] : null);
  const brThen = buyRatio(thenRow);
  if (brNow == null || brThen == null) return null;
  const d = brNow - brThen;
  if (d >= 0.05) return 3; if (d >= 0) return 2; if (d >= -0.05) return 1; return 0;
}

const FUND_FACTORS = [
  { key: "Quality", fn: (f, D, ind) => qualityPtsPIT(f, D, ind) },
  { key: "Leverage", fn: (f, D) => leveragePtsPIT(f, D) },
  { key: "Catalyst", fn: (f, D) => catalystPtsPIT(f, D) },
  { key: "AnalystRev", fn: (f, D) => analystPtsPIT(f, D) },
];

function main() {
  const cache = loadSurvivorCache();
  const { records } = labelUniverse(cache, { bidirectional: false });
  console.log(`\n#1 fundamentals PIT — ${records.length} technical entries, fwd-21d\n`);

  const report = { method: "dated-PIT", horizon: 21, factors: {}, block: null, notAssessable: ["Valuation (fwd P/E — estimate vintage not datable)"] };
  const perEntryFundSum = []; // {sum of available fund pts, techScore, fwdRet} for the block test

  for (const F of FUND_FACTORS) {
    const xs = [], ys = [], buckets = { 0: [], 1: [], 2: [], 3: [] };
    for (const rec of records) {
      const f = fund[rec.sym]; if (!f || f.error) continue;
      const ind = f.profile?.industry || null;
      const pts = F.fn(f, rec.entryDate, ind);
      const ret = fwdReturnPct(rec, 21);
      if (pts == null || ret == null) continue;
      xs.push(pts); ys.push(ret); buckets[Math.max(0, Math.min(3, Math.round(pts)))].push(ret);
    }
    const b = k => ({ n: buckets[k].length, avgRet: round(mean(buckets[k])) });
    report.factors[F.key] = {
      n: xs.length, ic: round(pearson(xs, ys), 4), spearman: round(spearman(xs, ys), 4),
      buckets: { 0: b(0), 1: b(1), 2: b(2), 3: b(3) },
    };
  }

  // Block incremental lift: within the technical-entry population, split by the
  // summed available fundamental points (top vs bottom half) → does the fundamental
  // block separate forward returns the technical score alone didn't?
  for (const rec of records) {
    const f = fund[rec.sym]; if (!f || f.error) continue;
    const ind = f.profile?.industry || null;
    let sum = 0, cnt = 0;
    for (const F of FUND_FACTORS) { const p = F.fn(f, rec.entryDate, ind); if (p != null) { sum += p; cnt++; } }
    const ret = fwdReturnPct(rec, 21);
    if (cnt >= 3 && ret != null) perEntryFundSum.push({ sum, ret, tech: rec.buyScore });
  }
  perEntryFundSum.sort((a, b) => a.sum - b.sum);
  const half = Math.floor(perEntryFundSum.length / 2);
  const bottom = perEntryFundSum.slice(0, half), top = perEntryFundSum.slice(half);
  report.block = {
    n: perEntryFundSum.length,
    icSumVsRet: round(pearson(perEntryFundSum.map(x => x.sum), perEntryFundSum.map(x => x.ret)), 4),
    lowFund: { n: bottom.length, avgRet: round(mean(bottom.map(x => x.ret))) },
    highFund: { n: top.length, avgRet: round(mean(top.map(x => x.ret))) },
    lift: round(mean(top.map(x => x.ret)) - mean(bottom.map(x => x.ret))),
    corrWithTech: round(pearson(perEntryFundSum.map(x => x.sum), perEntryFundSum.map(x => x.tech)), 3),
  };

  writeFileSync(new URL("../../scratchpad/swing-validate/p8-fundamentals.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log("── per-factor PIT attribution (fwd-21d) ──");
  console.log("factor       n     IC      Spearman  buckets(avgRet: pts0/1/2/3)");
  for (const F of FUND_FACTORS) { const r = report.factors[F.key]; if (!r) continue;
    console.log(`${F.key.padEnd(11)} ${String(r.n).padStart(5)}  ${String(r.ic).padStart(7)}  ${String(r.spearman).padStart(7)}   ${[0,1,2,3].map(k=>r.buckets[k].avgRet+`(${r.buckets[k].n})`).join(" / ")}`);
  }
  const bl = report.block;
  console.log(`\n── fundamental BLOCK incremental lift (within technical entries) ──`);
  console.log(`  IC(sum vs fwd21) ${bl.icSumVsRet}  ·  low-fund ${bl.lowFund.avgRet}% (n${bl.lowFund.n}) vs high-fund ${bl.highFund.avgRet}% (n${bl.highFund.n}) → lift ${bl.lift}pp`);
  console.log(`  (corr of fundamental-sum with technical score: ${bl.corrWithTech})`);
  console.log(`\n  NOT PIT-assessable: ${report.notAssessable.join(", ")}`);
  console.log(`\n→ scratchpad/swing-validate/p8-fundamentals.json`);
}
main();
