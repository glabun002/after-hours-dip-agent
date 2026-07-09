// Last completed NYSE close via Yahoo Finance's public chart API (no key).
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

function nyParts(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
}

/** True when US equities are in regular hours (approx; ignores holidays). */
export function isNyseOpenNow() {
  const ny = nyParts();
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return false;
  const mins = Number(ny.hour) * 60 + Number(ny.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export async function getLastClose(ticker) {
  const key = ticker.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${key}?interval=1d&range=7d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${key}`);
  const body = await res.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo returned no chart data for ${key}`);

  const bars = result.timestamp
    .map((t, i) => ({ t, close: result.indicators.quote[0].close[i] }))
    .filter((b) => Number.isFinite(b.close));
  if (!bars.length) throw new Error(`No closes for ${key}`);

  // Drop the final bar while its session is still in progress.
  const todayNy = (() => { const p = nyParts(); return `${p.year}-${p.month}-${p.day}`; })();
  const barDayNy = (b) => { const p = nyParts(new Date(b.t * 1000)); return `${p.year}-${p.month}-${p.day}`; };
  let last = bars[bars.length - 1];
  if (bars.length > 1 && barDayNy(last) === todayNy && isNyseOpenNow()) {
    last = bars[bars.length - 2];
  }

  const data = { close: Number(last.close.toFixed(2)), closeDate: barDayNy(last) };
  cache.set(key, { at: Date.now(), data });
  return data;
}
