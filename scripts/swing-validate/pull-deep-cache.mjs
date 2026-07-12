/* Pull MAX daily history (2005-01 → today) for the 488-name universe + SPY + the
   12 sector ETFs + ^VIX, so the entry rule can be tested through the 2008 GFC,
   2011, 2015-16, 2018-Q4, 2020-COVID and 2022 bears. FMP's default EOD endpoint
   caps at ~5y; passing from/to returns full history. Reuses the symbol list and
   sector->ETF mapping from the existing 5y cache. Saves the same cache shape. */
import { readFileSync, writeFileSync } from "node:fs";

const KEY = (readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/FMP_API_KEY\s*=\s*([^\s]+)/) || [])[1];
const SRC = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const OUT = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const FROM = "2005-01-01", TO = "2026-07-10", CONC = 10;

const src = JSON.parse(readFileSync(SRC, "utf8"));
const names = Object.keys(src.histBySym);
const etfBySym = src.etfBySym || {};
const ETFS = [...new Set(Object.values(etfBySym))].filter(Boolean);
const allSyms = [...new Set([...names, ...ETFS, "SPY", "^VIX"])];
console.error(`pulling ${allSyms.length} symbols (${names.length} names + ${ETFS.length} ETFs + SPY + ^VIX), ${FROM}..${TO}`);

async function fetchHist(sym, tries = 3) {
  const enc = encodeURIComponent(sym);
  const u = `https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${enc}&from=${FROM}&to=${TO}&apikey=${KEY}`;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(u);
      if (r.status === 429) { await new Promise(z => setTimeout(z, 1500 * (t + 1))); continue; }
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j.historical || []);
      if (!arr.length) return [];
      // normalize to newest-first {date,open,high,low,close,volume}
      const out = arr.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
      out.sort((a, b) => (a.date < b.date ? 1 : -1));
      return out;
    } catch (e) { if (t === tries - 1) { console.error(`  ${sym} ERR ${e.message}`); return null; } await new Promise(z => setTimeout(z, 800)); }
  }
  return null;
}

const histBySym = {}; let etfHist = {}, spyHist = null, vixHist = null;
let done = 0, failed = 0;
async function worker(queue) {
  while (queue.length) {
    const sym = queue.shift();
    const h = await fetchHist(sym);
    if (h == null) failed++;
    if (sym === "SPY") spyHist = h || [];
    else if (sym === "^VIX") vixHist = h || [];
    else if (ETFS.includes(sym) && !names.includes(sym)) etfHist[sym] = h || [];
    else histBySym[sym] = h || [];
    if (++done % 50 === 0) console.error(`  ${done}/${allSyms.length}  (fails ${failed})`);
  }
}
const queue = [...allSyms];
await Promise.all(Array.from({ length: CONC }, () => worker(queue)));

// coverage stats
const cov = (cut) => names.filter(s => (histBySym[s] || []).some(b => b.date <= cut)).length;
const out = {
  builtFrom: FROM, to: TO, count: names.length,
  spyHist, vixHist, etfBySym, etfHistBySym: etfHist, histBySym,
  meta: { pulledSyms: allSyms.length, failed, cov2008: cov("2008-06-30"), cov2018: cov("2018-06-30"), cov2020: cov("2020-01-31") },
};
writeFileSync(OUT, JSON.stringify(out));
const lens = names.map(s => (histBySym[s] || []).length).sort((a, b) => a - b);
console.error(`\nDONE. failed=${failed}`);
console.error(`SPY bars: ${spyHist?.length} (${spyHist?.[spyHist.length-1]?.date}..${spyHist?.[0]?.date})  VIX bars: ${vixHist?.length}`);
console.error(`name bars min/med/max: ${lens[0]}/${lens[Math.floor(lens.length/2)]}/${lens[lens.length-1]}`);
console.error(`coverage (names with data before): 2008-06=${out.meta.cov2008}  2018-06=${out.meta.cov2018}  2020-01=${out.meta.cov2020}`);
console.error(`wrote ${OUT.pathname}`);
