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
module.exports = { parseStooqCsv, parseYahooChart, parseTwelveData, mergeBars, parseFredCsv, parseVixCsv };
