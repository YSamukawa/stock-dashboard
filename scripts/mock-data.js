#!/usr/bin/env node
// Generates synthetic data/ files in the exact shape fetch.js writes — for local preview / UI tests.
// Usage: node scripts/mock-data.js   (overwrites data/*.json with mock content; never run in CI)
'use strict';
const fs = require('fs');
const path = require('path');
const AN = require('./lib/analysis');
const SEC = require('./lib/sec');
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const symbols = [...new Set([cfg.bench, ...cfg.symbols].map((s) => s.toUpperCase()))];

function rng(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
function genBars(sym) {
  let seed = 0; for (const ch of sym) seed = (seed * 31 + ch.charCodeAt(0)) % 233280; const rnd = rng(seed + 1);
  const bars = []; const d = new Date(); d.setUTCDate(d.getUTCDate() - 2200); let px = 40 + rnd() * 200; const trend = (rnd() - 0.35) * 0.0015;
  while (d < new Date()) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; const k = bars.length; px *= 1 + trend + Math.sin(k / 120) * 0.003 + (rnd() - 0.5) * 0.028; const o = px * (1 + (rnd() - 0.5) * 0.01), c = px; bars.push({ t: d.toISOString().slice(0, 10), o: +o.toFixed(2), h: +(Math.max(o, c) * (1 + rnd() * 0.012)).toFixed(2), l: +(Math.min(o, c) * (1 - rnd() * 0.012)).toFixed(2), c: +c.toFixed(2), v: Math.round(2e6 * (0.4 + rnd() * 1.4)) }); }
  return { bars, rnd };
}
const index = { updatedAt: new Date().toISOString(), bench: cfg.bench.toUpperCase(), symbols: [], mock: true, errors: [] };
for (const sym of symbols) {
  const { bars, rnd } = genBars(sym);
  const rec = { symbol: sym, updatedAt: new Date().toISOString(), errors: [], priceSource: 'mock', bars: bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]), lastDate: bars[bars.length - 1].t, lastClose: bars[bars.length - 1].c, drawdown: AN.drawdowns(bars, 10) };
  if (sym !== index.bench && !cfg.secSkip.includes(sym)) {
    // quarterly EPS growing with price/25
    const qeps = []; const first = new Date(bars[0].t); first.setUTCDate(1);
    for (let q = 0; q < 26; q++) { const e = new Date(first); e.setUTCMonth(e.getUTCMonth() + 3 * (q + 1)); e.setUTCDate(0); const end = e.toISOString().slice(0, 10); const bar = bars.find((b) => b.t >= end) || bars[bars.length - 1]; const filed = new Date(e); filed.setUTCDate(filed.getUTCDate() + 35); qeps.push({ end, start: '', eps: +((bar.c / 25) * (0.9 + rnd() * 0.2) / 4).toFixed(2), fy: e.getUTCFullYear(), fp: 'Q' + (1 + q % 4), form: '10-Q', filed: filed.toISOString().slice(0, 10), derived: q % 4 === 3 }); }
    qeps.splice(0, qeps.length, ...qeps.filter((q) => q.filed <= rec.lastDate));
    const ttm = SEC.ttmSeries(qeps);
    const evs = qeps.filter((q) => q.filed <= rec.lastDate).slice(-10).map((q) => { const d = new Date(q.filed); d.setUTCDate(d.getUTCDate() - 3); const rd = new Date(d); rd.setUTCDate(rd.getUTCDate() + 1); return { filingDate: d.toISOString().slice(0, 10), reactionDate: rd.toISOString().slice(0, 10), afterClose: true, accession: 'mock' }; });
    const nextD = new Date(rec.lastDate); nextD.setUTCDate(nextD.getUTCDate() + 20 + Math.floor(rnd() * 40));
    evs.push({ filingDate: nextD.toISOString().slice(0, 10), reactionDate: nextD.toISOString().slice(0, 10), afterClose: true, accession: 'mock-future', estimated: true });
    const buys = Math.floor(rnd() * 4);
    const filings = [];
    for (let i = 0; i < buys + 3; i++) { const d = new Date(rec.lastDate); d.setUTCDate(d.getUTCDate() - Math.floor(rnd() * 300)); const t = d.toISOString().slice(0, 10); const px = (bars.find((b) => b.t >= t) || bars[bars.length - 1]).c; const sh = Math.round(500 + rnd() * 20000); filings.push({ filingDate: t, accession: 'm' + i, parsed: { owners: [{ name: ['Smith John', 'Lee Ann', 'Garcia Luis', 'Chen Wei'][i % 4], roles: [['Director'], ['Chief Executive Officer'], ['Chief Financial Officer'], ['10% Owner']][i % 4] }], transactions: [{ date: t, code: i < buys ? 'P' : 'S', ad: i < buys ? 'A' : 'D', shares: sh, price: px, value: +(sh * px).toFixed(2) }] } }); }
    const since = new Date(); since.setMonth(since.getMonth() - 12);
    rec.sec = { cik: '0000000000', name: sym + ' Corp (mock)', qeps: qeps.slice(-24), ttm, peBand: AN.peBand(bars, ttm, cfg.peYears || 5), earnings: AN.earningsReactions(bars, evs), insiders: Object.assign(SEC.summarizeInsiders(filings, since.toISOString().slice(0, 10)), { filingsInWindow: filings.length, parsed: filings.length, pending: 0 }), errors: [] };
  } else if (sym !== index.bench) rec.sec = { skipped: true, errors: [] };
  fs.writeFileSync(path.join(DATA, sym + '.json'), JSON.stringify(rec));
  index.symbols.push({ symbol: sym, name: rec.sec?.name || null, lastDate: rec.lastDate, lastClose: rec.lastClose, priceSource: 'mock', insiderBuys: rec.sec?.insiders?.buyCount ?? null, errors: [] });
}
// macro
const m = { dgs10: [], dgs2: [], vix: [], errors: [], updatedAt: new Date().toISOString(), mock: true }; const rnd = rng(42); const d = new Date(); d.setUTCDate(d.getUTCDate() - 400); let y10 = 4.2, y2 = 3.8, vix = 16;
while (d < new Date()) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; const t = d.toISOString().slice(0, 10); y10 += (rnd() - 0.5) * 0.06; y2 += (rnd() - 0.5) * 0.06; vix = Math.max(10, vix + (rnd() - 0.5) * 2); m.dgs10.push({ t, v: +y10.toFixed(2) }); m.dgs2.push({ t, v: +y2.toFixed(2) }); m.vix.push({ t, v: +vix.toFixed(2) }); }
fs.writeFileSync(path.join(DATA, 'macro.json'), JSON.stringify(m));
index.macro = { dgs10: m.dgs10.at(-1), dgs2: m.dgs2.at(-1), vix: m.vix.at(-1), errors: [] };
fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify(index));
console.log('mock data written for', symbols.join(', '));
