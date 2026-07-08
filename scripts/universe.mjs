/* Shared study universe — ~90 liquid US large/mid-caps across sectors. Its own
   module (no side effects) so scripts can import the list without triggering
   another script's main(). Static list = deterministic, but note it's today's
   survivors — read universe numbers as indicative and lean on the watchlist
   cross-check. */
export const UNIVERSE = [
  // Mega tech / software
  "AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA","AVGO","ORCL","CRM","ADBE","NOW","SNOW","PLTR","PANW","CRWD","DDOG","NET","SHOP","UBER","NFLX",
  // Semis
  "AMD","INTC","MU","QCOM","TXN","AMAT","LRCX","KLAC","NXPI","ON","MRVL","ADI","MCHP","ASYS",
  // Financials
  "JPM","BAC","WFC","GS","MS","C","SCHW","AXP","V","MA","BLK","COF",
  // Health
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ISRG","AMGN","GILD","BMY",
  // Consumer / retail
  "WMT","COST","HD","LOW","NKE","SBUX","MCD","TGT","DIS","BKNG","CMG",
  // Energy / industrials / materials
  "XOM","CVX","COP","SLB","OXY","BA","CAT","DE","GE","HON","UPS","LMT","FCX",
  // Comms / other liquid movers
  "CMCSA","T","VZ","PYPL","COIN","MRNA","SMCI","DELL",
];
