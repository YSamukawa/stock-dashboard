// Price-source parsers (pure) — Stooq CSV, Yahoo chart JSON, Twelve Data JSON → bars [{t,o,h,l,c,v}]
'use strict';
function parseStooqCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!/^Date,Open,High,Low,Close/i.test(lines[0] || '')) return [];
  const out = [];
  for (const ln of lines.slice(1)) {
    const [t, o, h, l, c, v] = ln.split(',');
    if (!t || !isFinite(+c)) continue;
    out.push({ t, o: +o, h: +h, l: +l, c: +c, v: +v || 0 });
  }
  return out;
}
function parseYahooChart(json) {
  const r = json?.chart?.result?.[0]; if (!r) return [];
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i]; if (c == null) continue;
    const t = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    out.push({ t, o: q.open[i] ?? c, h: q.high[i] ?? c, l: q.low[i] ?? c, c, v: q.volume?.[i] || 0 });
  }
  return out;
}
function parseTwelveData(json) {
  const out = [];
  for (const r of json?.values || []) { const c = +r.close; if (!isFinite(c)) continue; out.push({ t: String(r.datetime).slice(0, 10), o: +r.open, h: +r.high, l: +r.low, c, v: +r.volume || 0 }); }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1));
}
// merge existing bars with fresh bars (fresh wins on same date), ascending, dedup
function mergeBars(oldBars, newBars) {
  const m = new Map();
  for (const b of oldBars || []) m.set(b.t, b);
  for (const b of newBars || []) m.set(b.t, b);
  return [...m.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}
function parseFredCsv(text) {
  const out = [];
  for (const ln of text.trim().split(/\r?\n/).slice(1)) { const [t, v] = ln.split(','); if (t && v && v !== '.') out.push({ t, v: +v }); }
  return out;
}
// Cboe VIX_History.csv: DATE,OPEN,HIGH,LOW,CLOSE with M/D/YYYY dates
function parseVixCsv(text) {
  const out = [];
  for (const ln of text.trim().split(/\r?\n/).slice(1)) {
    const [d, o, h, l, c] = ln.split(','); if (!d || !isFinite(+c)) continue;
    let t = d.trim();
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) t = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    out.push({ t, v: +c });
  }
  return out;
}

// --- US Eastern time helpers (DST: 2nd Sun of March → 1st Sun of November) ---
function etParts(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const nthSunday = (m, n) => { const x = new Date(Date.UTC(y, m, 1)); const first = ((7 - x.getUTCDay()) % 7) + 1; return new Date(Date.UTC(y, m, first + 7 * (n - 1), 7)); };
  const off = d >= nthSunday(2, 2) && d < nthSunday(10, 1) ? -4 : -5;
  const et = new Date(d.getTime() + off * 3600e3);
  return { date: et.toISOString().slice(0, 10), hour: et.getUTCHours() + et.getUTCMinutes() / 60, offset: off };
}
// Price sources return an in-progress bar while the US session is open. Drop it so that
// "last close" / volume-vs-average are never computed from a partial day.
function dropPartialBar(bars, nowMs = Date.now()) {
  if (!bars || !bars.length) return { bars: bars || [], dropped: null };
  const { date, hour } = etParts(nowMs);
  const last = bars[bars.length - 1];
  if (last.t === date && hour < 16.084) return { bars: bars.slice(0, -1), dropped: last.t };
  return { bars, dropped: null };
}
// Yahoo chart JSON → [{date, ratio}] ascending. ratio = numerator/denominator (10 for a 10-for-1 split).
function parseYahooSplits(json) {
  const ev = json?.chart?.result?.[0]?.events?.splits || {};
  const out = [];
  for (const k of Object.keys(ev)) {
    const s = ev[k] || {};
    let ratio = null;
    if (s.numerator > 0 && s.denominator > 0) ratio = s.numerator / s.denominator;
    else if (typeof s.splitRatio === 'string' && s.splitRatio.includes(':')) { const [a, b] = s.splitRatio.split(':').map(Number); if (a > 0 && b > 0) ratio = a / b; }
    if (!ratio || !isFinite(ratio) || ratio <= 0 || ratio === 1) continue;
    const ts = s.date != null ? s.date : +k;
    if (!isFinite(ts)) continue;
    out.push({ date: new Date(ts * 1000).toISOString().slice(0, 10), ratio: +ratio.toFixed(6) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
module.exports = { parseStooqCsv, parseYahooChart, parseTwelveData, mergeBars, parseFredCsv, parseVixCsv, etParts, dropPartialBar, parseYahooSplits };
