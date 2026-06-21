// Shared FMP CDN sym-flip probe — used by the /api/health endpoint and as a
// pre-flight safety gate before full rescans. Requests /profile for three
// unrelated tickers and confirms each returns its OWN correct company.

const FMP = "https://financialmodelingprep.com/stable";
const PROBES = [
  { sym: "NVDA", expect: "nvidia" },
  { sym: "AAPL", expect: "apple" },
  { sym: "KO",   expect: "coca" },
];

export async function probeFmpHealth() {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    return { status: "error", message: "FMP_API_KEY not configured", probes: [], checked_at: new Date().toISOString() };
  }

  const probes = await Promise.all(PROBES.map(async ({ sym, expect }) => {
    try {
      const r = await fetch(`${FMP}/profile?symbol=${sym}&apikey=${key}`, { cache: "no-store" });
      if (!r.ok) return { sym, ok: false, error: `HTTP ${r.status}` };
      const data = await r.json();
      const p = Array.isArray(data) ? data[0] : data;
      const name = p?.companyName || null;
      const retSym = (p?.symbol || "").toUpperCase();
      const nameOk = name ? name.toLowerCase().includes(expect) : false;
      return { sym, ok: !!(name && retSym === sym && nameOk), name, returned_symbol: retSym || null, price: p?.price ?? null };
    } catch (e) {
      return { sym, ok: false, error: String(e.message || e) };
    }
  }));

  const names = probes.map(p => (p.name || "").toLowerCase()).filter(Boolean);
  const duplicateName = names.length !== new Set(names).size;
  const anyMismatch = probes.some(p => !p.ok);

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

  return { status, message, checked_at: new Date().toISOString(), probes };
}
