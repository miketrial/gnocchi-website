const FMP = "https://financialmodelingprep.com/stable";
const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "BATS", "NYSE ARCA", "NYSE AMERICAN"]);

export default async (req) => {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 1) return Response.json([]);

  const key = process.env.FMP_API_KEY;
  const fetchJson = async (ep) => {
    try {
      const r = await fetch(`${FMP}/${ep}?query=${encodeURIComponent(q)}&limit=25&apikey=${key}`);
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch { return []; }
  };

  // Search by ticker AND by company name so "apple" finds AAPL and "AAPL" finds Apple.
  const [bySym, byName] = await Promise.all([
    fetchJson("search-symbol"),
    fetchJson("search-name"),
  ]);

  const seen = new Set();
  const merged = [];
  for (const r of [...bySym, ...byName]) {
    if (!r.symbol || r.symbol.includes(".")) continue;            // skip foreign/class shares
    const exch = r.exchange || r.exchangeShortName || null;
    if (!US_EXCHANGES.has(exch)) continue;                        // US listings only
    const sym = r.symbol.toUpperCase();
    if (seen.has(sym)) continue;                                  // dedupe across both feeds
    seen.add(sym);
    merged.push({ symbol: sym, name: r.name || "", exchange: exch });
  }

  // Rank: exact ticker → ticker prefix → name prefix → name contains → everything else.
  const ql = q.toLowerCase();
  const rank = (r) => {
    const s = r.symbol.toLowerCase(), n = (r.name || "").toLowerCase();
    if (s === ql) return 0;
    if (s.startsWith(ql)) return 1;
    if (n.startsWith(ql)) return 2;
    if (n.includes(ql)) return 3;
    return 4;
  };
  merged.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));

  return Response.json(merged.slice(0, 8));
};
