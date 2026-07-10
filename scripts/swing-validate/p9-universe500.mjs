/* ===== #3 — transferability: re-run the technical validation on the broad ~500
   universe and compare to the 90-survivor numbers. Do the factor verdicts hold?
   Usage: node scripts/swing-validate/p9-universe500.mjs */
import {
  loadSurvivorCache, labelUniverse, splitByDate, aggregateShortRule, shortExitGridReport,
  swingExitGrid, fwdReturnPct, pearson, spearman, mean, winRate, round, FACTOR_KEYS,
} from "./lib.mjs";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const U500 = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
if (!existsSync(U500)) { console.error("universe500-cache.json missing"); process.exit(1); }
const cache500 = JSON.parse(readFileSync(U500, "utf8"));
const survivor = loadSurvivorCache();
const LABEL = { TREND: "Trend", MOM: "3M-Momentum", EXTREME: "Near-High", LIQ: "Liquidity", VOL: "Volume-Surge", SECRS: "Sector-RS" };

function factorIC(records, key, H = 21) {
  const xs = [], ys = [], buckets = { 0: [], 1: [], 2: [], 3: [] };
  for (const rec of records) {
    const f = rec.factors.find(ff => ff.key === key); if (!f) continue;
    const p = f.buy, r = fwdReturnPct(rec, H); if (p == null || r == null) continue;
    xs.push(p); ys.push(r); buckets[Math.max(0, Math.min(3, Math.round(p)))].push(r);
  }
  const b0 = mean(buckets[0]), b3 = mean(buckets[3]);
  return { n: xs.length, ic: round(pearson(xs, ys), 4), sp: round(spearman(xs, ys), 4), topBot: (b0 != null && b3 != null) ? round(b3 - b0) : null };
}

function analyze(cache, label) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  const inc = swingExitGrid().find(r => r.label === "maCross_atr40");
  const hold63 = swingExitGrid().find(r => r.label === "hold63");
  const { OOS } = splitByDate(records);
  const raw = records.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
  return {
    label, nNames: Object.keys(cache.histBySym).length, nEntries: records.length,
    rawFwd21: round(mean(raw)), rawWin: round(winRate(raw), 3),
    factors: Object.fromEntries(FACTOR_KEYS.map(k => [k, factorIC(records, k)])),
    incExp: round(aggregateShortRule(records, inc, cache.spyHist).expectancy),
    incOOS: round(aggregateShortRule(OOS, inc, cache.spyHist).expectancy),
    hold63Exp: round(aggregateShortRule(records, hold63, cache.spyHist).expectancy),
    hold63Edge: round(aggregateShortRule(records, hold63, cache.spyHist).edge),
  };
}

const s = analyze(survivor, "survivors-90");
const b = analyze(cache500, "broad-488");
writeFileSync(new URL("../../scratchpad/swing-validate/p9-universe500.json", import.meta.url), JSON.stringify({ survivor: s, broad: b }, null, 2));

console.log(`\n#3 transferability — factor IC (fwd-21d): 90-survivor vs 488-broad universe\n`);
console.log("factor        surv-IC  surv-topBot   broad-IC  broad-topBot   verdict transfers?");
for (const k of FACTOR_KEYS) {
  const sv = s.factors[k], bv = b.factors[k];
  const sameSign = Math.sign(sv.ic || 0) === Math.sign(bv.ic || 0);
  console.log(`${LABEL[k].padEnd(13)} ${String(sv.ic).padStart(7)}  ${String(sv.topBot).padStart(9)}    ${String(bv.ic).padStart(7)}  ${String(bv.topBot).padStart(9)}     ${sameSign ? "✓ same sign" : "✗ FLIPS"}`);
}
console.log(`\n── headline (incumbent maCross_atr40 / hold63) ──`);
console.log(`  survivors-90  : entries ${s.nEntries}  rawFwd ${s.rawFwd21}%  incExp ${s.incExp}% (OOS ${s.incOOS})  hold63 ${s.hold63Exp}% edge ${s.hold63Edge}`);
console.log(`  broad-488     : entries ${b.nEntries}  rawFwd ${b.rawFwd21}%  incExp ${b.incExp}% (OOS ${b.incOOS})  hold63 ${b.hold63Exp}% edge ${b.hold63Edge}`);
console.log(`\n→ scratchpad/swing-validate/p9-universe500.json`);
