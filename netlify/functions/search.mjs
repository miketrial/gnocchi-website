const FMP = "https://financialmodelingprep.com/stable";
const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "BATS", "NYSE ARCA", "NYSE AMERICAN"]);

export default async (req) => {
  const q = new URL(req.url).searchParams.get("q") || "";
  if (q.length < 1) return Response.json([]);

  const key = process.env.FMP_API_KEY;
  const res = await fetch(`${FMP}/search-symbol?query=${encodeURIComponent(q)}&apikey=${key}`);
  if (!res.ok) return Response.json([]);

  const data = await res.json();
  const filtered = (Array.isArray(data) ? data : [])
    .filter(r => US_EXCHANGES.has(r.exchange) && !r.symbol.includes("."))
    .slice(0, 8)
    .map(r => ({ symbol: r.symbol, name: r.name, exchange: r.exchange }));

  return Response.json(filtered);
};
