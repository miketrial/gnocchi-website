/* Probe: confirm deep-cache shape + that v6.2 entries fire WITH spyRet126. */
import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, ret126SeriesFor } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
console.log("top-level keys:", Object.keys(c));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const names = Object.keys(histBySym);
console.log("n names:", names.length, "| n etfHist:", Object.keys(etfHistBySym || {}).length);
console.log("spyHist len:", spyHist.length, "newest:", spyHist[0].date, "oldest:", spyHist[spyHist.length - 1].date);
console.log("sample spy bar:", JSON.stringify(spyHist[0]));
const s0 = names[0];
console.log("sample name:", s0, "hist len:", histBySym[s0].length, "etf:", etfBySym?.[s0]);
console.log("sample name bar:", JSON.stringify(histBySym[s0][0]));

const spyStr = strengthSeriesFor(spyHist);
const spyR126 = ret126SeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };

// count v6.2 entries (fresh flat->strong) over a 60-name sample, WITH spyRet126
let entriesV62 = 0, entriesNoRs = 0, scored = 0, namesWithEntry = 0;
const sample = names.slice(0, 60);
for (const sym of sample) {
  const hist = histBySym[sym]; if (!hist || hist.length < 520) continue;
  const etf = etfBySym?.[sym] || null; const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200;
  let prevStrong = false, any = false;
  for (let i = lastScorable; i >= 0; i--) { // oldest->newest so "fresh" = !prev && now
    const opts = { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) };
    const sigNoRs = computeShortSignal(hist.slice(i, i + 260), opts);
    const sig = computeShortSignal(hist.slice(i, i + 260), { ...opts, spyRet126: strengthAsOf(spyR126, hist[i].date) });
    if (!sig) continue;
    scored++;
    if (sigNoRs && sigNoRs.entryStrong) entriesNoRs++;
    const now = !!sig.entryStrong;
    if (now && !prevStrong) { entriesV62++; any = true; }
    prevStrong = now;
  }
  if (any) namesWithEntry++;
}
console.log(`\nsample=${sample.length} names, scored bars=${scored}`);
console.log(`v6.2 fresh entries (with rs126 gate): ${entriesV62}  across ${namesWithEntry} names`);
console.log(`(for contrast) bar-count entryStrong WITHOUT rs126 passed: ${entriesNoRs}`);
