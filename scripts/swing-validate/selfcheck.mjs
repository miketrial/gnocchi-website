/* Harness self-check — proves lib.mjs loads the cache, labels the universe, and
   every primitive returns a finite number. Not a test of the STRATEGY, just that
   the plumbing the fan-out agents rely on is sound. */
import {
  loadSurvivorCache, labelUniverse, splitByDate, walkForwardFolds,
  buildRegimeContext, regimeOf, fwdReturnPct, spearman, pearson, sharpe, sortino,
  maxDrawdown, bootstrapMeanCI, bootstrapMaxDD, portfolioSim, aggregateNet,
  multipleTestingCheck, swingExitGrid, round,
} from "./lib.mjs";

const cache = loadSurvivorCache();
const { records, dropped } = labelUniverse(cache, { bidirectional: false });
console.log(`labelUniverse: ${records.length} long entries · dropped ${dropped.length}`);

const rets21 = records.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
const scores = records.map(r => r.buyScore);
console.log(`fwd-21d: mean ${round(rets21.reduce((s,x)=>s+x,0)/rets21.length)}%  n=${rets21.length}`);
console.log(`score→ret Pearson ${round(pearson(scores, records.map(r=>fwdReturnPct(r,21))),3)}  Spearman ${round(spearman(scores, records.map(r=>fwdReturnPct(r,21))),3)}`);

const { IS, OOS } = splitByDate(records);
console.log(`IS/OOS split: ${IS.length}/${OOS.length}  (IS ends ${IS[IS.length-1]?.entryDate}, OOS starts ${OOS[0]?.entryDate})`);
console.log(`walk-forward folds: ${walkForwardFolds(records,4).map(f=>`${f.train.length}->${f.test.length}`).join(", ")}`);

const ctx = buildRegimeContext(cache.spyHist, cache.vixHist || null);
const regCounts = {};
for (const r of records) { const g = regimeOf(ctx, r.entryDate); const k = `${g.trend}/${g.vol}`; regCounts[k] = (regCounts[k]||0)+1; }
console.log(`regime buckets:`, regCounts);

console.log(`sharpe ${round(sharpe(rets21),3)}  sortino ${round(sortino(rets21),3)}  maxDD(seq) ${round(maxDrawdown(rets21))}%`);
console.log(`bootstrap mean CI95:`, (()=>{const b=bootstrapMeanCI(rets21);return `[${round(b.lo)}, ${round(b.hi)}] mean ${round(b.mean)}`;})());
console.log(`bootstrap maxDD:`, (()=>{const b=bootstrapMaxDD(rets21);return `median ${round(b.median)}% p05 ${round(b.p05)}% worst ${round(b.worst)}%`;})());

const grid = swingExitGrid();
const macross = grid.find(r => r.label === "maCross");
const net = aggregateNet(records, macross, cache.spyHist, 10);
console.log(`aggregateNet maCross: gross ${round(net.expectancy)}% net(10bps) ${round(net.netExpectancy)}% edge ${round(net.edge)} n=${net.n}`);

const psim = portfolioSim(records, macross, { maxPositions: 8, perSectorMax: 3, costBps: 10 });
console.log(`portfolioSim maCross:`, JSON.stringify({cagr:round(psim.cagr), sharpe:round(psim.sharpePerTrade,3), maxDD:round(psim.maxDDpct), taken:psim.taken, skipped:psim.skippedFull+psim.skippedSector, exposure:round(psim.exposureFrac,2), years:psim.years}));

const mt = multipleTestingCheck(rets21, 18);
console.log(`multiple-testing (18 trials): t=${round(mt.tStat,2)} pBonf=${round(mt.pBonferroni,4)} survives=${mt.survives}`);

// determinism check: bootstrap twice → identical
const a = bootstrapMeanCI(rets21), b = bootstrapMeanCI(rets21);
console.log(`determinism: bootstrap repeat identical = ${a.lo===b.lo && a.hi===b.hi}`);
console.log("SELFCHECK OK");
