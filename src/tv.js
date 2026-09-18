// ===== TradingView CSV import (local only) — pure functions =====
const TV = (() => {
  const CORE = ['time', 'open', 'high', 'low', 'close', 'volume'];
  function splitCsvLine(ln) { // handles simple quoted fields
    const out = []; let cur = '', q = false;
    for (const ch of ln) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out;
  }
  // → { columns:[{key,name}], rows:[{t,o,h,l,c,v,x:{key:val}}], tf:'1D'|'1W'|..., from, to }
  function parse(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new Error('空のファイル');
    const hdr = splitCsvLine(lines[0]).map((h) => h.trim());
    if (hdr[0] !== 'time' || !hdr.includes('close')) throw new Error('TradingViewのチャートCSV（time,open,high,low,close,…）ではありません');
    const seen = {}; const keys = hdr.map((h) => { const k = h; seen[k] = (seen[k] || 0) + 1; return seen[k] > 1 ? `${k}#${seen[k]}` : k; });
    const idx = (n) => keys.findIndex((k) => k.toLowerCase() === n);
    const iT = idx('time'), iO = idx('open'), iH = idx('high'), iL = idx('low'), iC = idx('close'), iV = idx('volume');
    const extraKeys = keys.filter((k, i) => ![iT, iO, iH, iL, iC, iV].includes(i));
    const rows = [];
    for (const ln of lines.slice(1)) {
      const f = splitCsvLine(ln); const ts = +f[iT]; const c = +f[iC];
      if (!isFinite(ts) || !isFinite(c)) continue;
      const t = new Date(ts * 1000).toISOString().slice(0, 10); // US session open (13:30/14:30 UTC) → same calendar date
      const x = {}; for (const k of extraKeys) { const v = f[keys.indexOf(k)]; x[k] = v === '' || v == null ? null : isFinite(+v) ? +v : v; }
      rows.push({ t, o: +f[iO], h: +f[iH], l: +f[iL], c, v: iV >= 0 ? +f[iV] || 0 : 0, x });
    }
    rows.sort((a, b) => (a.t < b.t ? -1 : 1));
    const dedup = rows.filter((r, i) => i === 0 || r.t !== rows[i - 1].t);
    // timeframe guess from median gap (days)
    let tf = '1D';
    if (dedup.length > 3) { const gaps = []; for (let i = 1; i < Math.min(dedup.length, 40); i++) gaps.push((new Date(dedup[i].t) - new Date(dedup[i - 1].t)) / 86400000); gaps.sort((a, b) => a - b); const g = gaps[Math.floor(gaps.length / 2)]; tf = g >= 25 ? '1M' : g >= 5 ? '1W' : g >= 1 ? '1D' : 'intraday'; }
    if (tf === 'intraday') { const same = rows.filter((r, i) => i > 0 && r.t === rows[i - 1].t).length; if (same > 0) tf = 'intraday'; }
    return { columns: extraKeys.map((k) => ({ key: k, name: k.replace(/#\d+$/, '') })), rows: tf === 'intraday' ? rows : dedup, tf, from: rows[0]?.t, to: rows[rows.length - 1]?.t, bars: rows.length };
  }
  // classify extra columns: overlay (price-scale) vs pane, numeric only
  function classify(parsed) {
    const closes = parsed.rows.map((r) => r.c).filter((x) => x > 0).sort((a, b) => a - b);
    const med = closes[Math.floor(closes.length / 2)] || 1;
    return parsed.columns.map((col) => {
      const vals = parsed.rows.map((r) => r.x[col.key]).filter((v) => typeof v === 'number' && isFinite(v));
      if (vals.length < 5) return { ...col, kind: 'skip', count: vals.length };
      const s = [...vals].sort((a, b) => a - b); const m = s[Math.floor(s.length / 2)];
      const isEst = /estimate|forecast|予想/i.test(col.name);
      const kind = isEst ? 'estimate' : m > med * 0.4 && m < med * 2.5 ? 'overlay' : 'pane';
      return { ...col, kind, count: vals.length, median: m };
    });
  }
  // symbol/timeframe from TradingView file name e.g. "BATS_AVGO, 1D_b9f1a.csv" / "NASDAQ_NVDA, 1W.csv"
  function guessSymbol(fileName) {
    // pattern: <EXCHANGE>_<SYMBOL>[,] <TF>...  → take the token after the first underscore
    const base = fileName.replace(/\.csv$/i, '');
    // <EXCHANGE>_<SYMBOL> anywhere in the name (upload tools may prefix ids), then an optional timeframe token
    const m = base.match(/(?:^|[^A-Za-z0-9])([A-Z]{2,12})_([A-Z0-9.\-]{1,10})(?:[,\s_]+(\d+[DWMHS]?))?(?=$|[^A-Za-z0-9.])/);
    if (!m) return { symbol: '', tf: '' };
    return { symbol: m[2].toUpperCase(), tf: (m[3] || '').toUpperCase() };
  }
  // stepped estimate history: for each estimate column, list of {from, to, value} periods
  function estimateHistory(parsed) {
    const cols = parsed.columns.filter((c) => /estimate/i.test(c.name));
    const out = {};
    for (const c of cols) {
      const periods = []; let cur = null;
      for (const r of parsed.rows) { const v = r.x[c.key]; if (v == null) continue; if (!cur || cur.value !== v) { cur = { from: r.t, to: r.t, value: v }; periods.push(cur); } else cur.to = r.t; }
      out[c.name] = periods;
    }
    return out;
  }
  // snapshot of the latest estimate values (for revision logging across uploads)
  function latestEstimates(parsed) {
    const last = parsed.rows[parsed.rows.length - 1]; if (!last) return null;
    const o = {}; for (const c of parsed.columns) if (/estimate/i.test(c.name) && typeof last.x[c.key] === 'number') o[c.name] = last.x[c.key];
    return Object.keys(o).length ? { asOf: last.t, values: o } : null;
  }
  // merge TV bars over base bars (TV wins on overlapping dates; base keeps older history)
  function mergeBars(base, tvRows) {
    const m = new Map(); for (const b of base || []) m.set(b.t, b);
    for (const r of tvRows) m.set(r.t, { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v });
    return [...m.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
  }
  // revision log from stored snapshots [{uploadedAt, asOf, values}] → rows with deltas vs previous snapshot
  function revisions(snaps) {
    const s = [...snaps].sort((a, b) => (a.uploadedAt < b.uploadedAt ? -1 : 1));
    return s.map((cur, i) => { const prev = s[i - 1]; const d = {}; for (const k in cur.values) d[k] = prev && prev.values[k] != null && prev.values[k] !== 0 ? (cur.values[k] / prev.values[k] - 1) * 100 : null; return { uploadedAt: cur.uploadedAt, asOf: cur.asOf, values: cur.values, deltaPct: d }; }).reverse();
  }
  return { parse, classify, guessSymbol, estimateHistory, latestEstimates, mergeBars, revisions };
})();
if (typeof module !== 'undefined') module.exports = TV;
