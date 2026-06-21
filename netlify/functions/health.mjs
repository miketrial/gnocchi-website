// GET /api/health → live probe of FMP's CDN for the sym-flip condition.
// Curls /profile for 3 distinct, unrelated tickers and confirms each returns
// its OWN company (correct symbol + distinct names). If the CDN is flipping,
// two or more will come back with the same company — caught here in one click.

const FMP = "https://financialmodelingprep.com/stable";
const PROBES = [
  { sym: "NVDA", expect: "nvidia" },
  { sym: "AAPL", expect: "apple" },
  { sym: "KO",   expect: "coca" },
];

export default async () => {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    return Response.json({ status: "error", error: "FMP_API_KEY not configured" }, { status: 500 });
  }

  const results = await Promise.all(PROBES.map(async ({ sym, expect }) => {
    try {
      const r = await fetch(`${FMP}/profile?symbol=${sym}&apikey=${key}`, { cache: "no-store" });
      if (!r.ok) return { sym, ok: false, error: `HTTP ${r.status}` };
      const data = await r.json();
      const p = Array.isArray(data) ? data[0] : data;
      const name = p?.companyName || null;
      const retSym = (p?.symbol || "").toUpperCase();
      const nameOk = name ? name.toLowerCase().includes(expect) : false;
      const symOk = retSym === sym;
      return { sym, ok: !!(name && symOk && nameOk), name, returned_symbol: retSym || null, price: p?.price ?? null };
    } catch (e) {
      return { sym, ok: false, error: String(e.message || e) };
    }
  }));

  // Flip detection: any two probes returning the same (non-null) company name.
  const names = results.map(r => (r.name || "").toLowerCase()).filter(Boolean);
  const duplicateName = names.length !== new Set(names).size;
  const anyMismatch = results.some(r => !r.ok);

  let status, message;
  if (duplicateName) {
    status = "flipping";
    message = "FMP CDN is currently FLIPPING — two or more tickers returned the same company. Do not force-rescan now; wait and re-check.";
  } else if (anyMismatch) {
    status = "degraded";
    message = "One or more probes returned an unexpected or missing company. FMP may be partially flipped — re-check before bulk rescans.";
  } else {
    status = "healthy";
    message = "FMP is serving distinct, correct companies for all probes. Safe to rescan.";
  }

  return Response.json({
    status,
    message,
    checked_at: new Date().toISOString(),
    probes: results,
  });
};
