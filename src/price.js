// BCH/USD for showing prices in cents. Two public sources, cached; null when both fail
// (the app then shows sats only). No user data is sent.
const SOURCES = [
  async () => (await (await fetch('https://api.kraken.com/0/public/Ticker?pair=BCHUSD', { signal: AbortSignal.timeout(8000) })).json()).result.BCHUSD.c[0],
  async () => (await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json())['bitcoin-cash'].usd,
];

export function livePrice({ ttlMs = 10 * 60_000 } = {}) {
  let cache = { at: 0, value: null };
  return async () => {
    if (Date.now() - cache.at < ttlMs && cache.value) return cache.value;
    for (const source of SOURCES) {
      try {
        const v = Number(await source());
        if (v > 1 && v < 1e6) { cache = { at: Date.now(), value: v }; return v; }
      } catch { /* try the next source */ }
    }
    return cache.value; // last known value, or null
  };
}
