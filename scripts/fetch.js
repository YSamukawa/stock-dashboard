#!/usr/bin/env node
// Daily data fetcher — run from repo root: `node scripts/fetch.js`
// Sources: Stooq → Yahoo (fallback) → Twelve Data (fallback, needs TWELVE_DATA_KEY), SEC EDGAR, FRED, Cboe.
// Writes data/index.json, data/<SYM>.json, data/macro.json, data/cache/form4/<SYM>.json
'use strict';
const fs = require('fs');
const path = require('path');
const { parseStooqCsv, parseYahooChart, parseTwelveData, mergeBars, parseFredCsv, parseVixCsv, dropPartialBar, parseYahooSplits, etParts } = require('./lib/prices');
const SEC = require('./lib/sec');
const AN = require('./lib/analysis');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const CACHE = path.join(DATA, 'cache', 'form4');
const cfg = Object.assign({ symbols: [], bench: 'SPY', secSkip: [], secUserAgent: '', insiderMonths: 12, form4MaxPerRun: 120, peYears: 5, keepBars: 2600 }, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
const UA = process.env.SEC_USER_AGENT || cfg.secUserAgent || 'ms-style-chart (github actions) contact: unknown@example.com';
const TD_KEY = process.env.TWELVE_DATA_KEY || '';
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(CACHE, { recursive: true });
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o));

async function http(url, opts = {}, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers || {}), signal: AbortSignal.timeout(30000) });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) return { ok: false, status: res.status, text: '' };
      return { ok: true, status: res.status, text: await res.text() };
    } catch (e) { if (i === tries) throw e; await sleep(1500 * i); }
  }
}
let lastSec = 0;
async function sec(url) { const wait = 130 - (Date.now() - lastSec); if (wait > 0) await sleep(wait); lastSec = Date.now(); return http(url, { headers: { 'Accept-Encoding': 'gzip, deflate' } }); }

// ---------- prices ----------
async function fetchBars(sym) {
  const tried = [];
  try { // Stooq
    const r = await http(`https://stooq.com/q/d/l/?s=${sym.toLowerCase()}.us&i=d`);
    const bars = r.ok ? parseStooqCsv(r.text) : [];
    if (bars.length > 50) return { bars, source: 'stooq' };
    tried.push('stooq:' + (r.ok ? r.text.slice(0, 40).replace(/\s+/g, ' ') : 'HTTP ' + r.status));
  } catch (e) { tried.push('stooq:' + e.message); }
  try { // Yahoo (unofficial)
    const r = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d&events=div%2Csplit`);
    const bars = r.ok ? parseYahooChart(JSON.parse(r.text)) : [];
    if (bars.length > 50) return { bars, source: 'yahoo' };
    tried.push('yahoo:' + (r.ok ? 'empty' : 'HTTP ' + r.status));
  } catch (e) { tried.push('yahoo:' + e.message); }
  if (TD_KEY) try { // Twelve Data
    const r = await http(`https://api.twelvedata.com/time_series?symbol=${sym}&interval=1day&outputsize=2500&apikey=${TD_KEY}`);
    const j = r.ok ? JSON.parse(r.text) : {};
    const bars = parseTwelveData(j);
    if (bars.length > 50) return { bars, source: 'twelvedata' };
    tried.push('twelvedata:' + (j.message || 'empty'));
  } catch (e) { tried.push('twelvedata:' + e.message); }
  return { bars: [], source: null, error: tried.join(' | ') };
}

// Split history comes from Yahoo whatever the price source is: SEC EPS facts are as-filed and must be
// re-based onto today's share count before any TTM sum or P/E is meaningful.
async function fetchSplits(sym) {
  try {
    const r = await http(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=15y&interval=1mo&events=split`);
    if (!r.ok) return { splits: [], error: 'HTTP ' + r.status };
    return { splits: parseYahooSplits(JSON.parse(r.text)), error: null };
  } catch (e) { return { splits: [], error: e.message }; }
}

// ---------- SEC ----------
let tickerMap = null;
async function cikFor(sym) {
  if (cfg.cikOverrides?.[sym]) return String(cfg.cikOverrides[sym]).padStart(10, '0');
  if (!tickerMap) {
    const r = await sec('https://www.sec.gov/files/company_tickers.json');
    tickerMap = {};
    if (r.ok) for (const v of Object.values(JSON.parse(r.text))) tickerMap[v.ticker.toUpperCase()] = { cik: String(v.cik_str).padStart(10, '0'), name: v.title };
  }
  return tickerMap[sym]?.cik || null;
}
async function fetchSec(sym, bars, prev, splits = []) {
  const out = { cik: null, name: prev?.sec?.name || null, splits, qeps: [], ttm: [], peBand: null, earnings: null, insiders: null, errors: [] };
  if (cfg.secSkip.includes(sym)) { out.skipped = true; return out; }
  const cik = await cikFor(sym);
  if (!cik) { out.errors.push('CIK not found in company_tickers.json'); return out; }
  out.cik = cik; out.name = tickerMap?.[sym]?.name || out.name;
  // companyfacts → EPS
  try {
    const r = await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    if (r.ok) { const q = SEC.quarterlyEps(JSON.parse(r.text), splits); out.qeps = q.slice(-24); out.ttm = SEC.ttmSeries(q); out.peBand = AN.peBand(bars, out.ttm, cfg.peYears); }
    else out.errors.push('companyfacts HTTP ' + r.status);
  } catch (e) { out.errors.push('companyfacts: ' + e.message); }
  // submissions → 8-K 2.02 + Form 4
  let sub = null;
  try { const r = await sec(`https://data.sec.gov/submissions/CIK${cik}.json`); if (r.ok) sub = JSON.parse(r.text); else out.errors.push('submissions HTTP ' + r.status); }
  catch (e) { out.errors.push('submissions: ' + e.message); }
  if (sub) {
    out.name = sub.name || out.name;
    const evs = SEC.earningsFilings(sub).map((f) => ({ ...f, ...SEC.reactionDate(f.filingDate, f.acceptance) })).map((f) => ({ filingDate: f.filingDate, reactionDate: f.date, afterClose: f.afterClose, accession: f.accession }));
    out.earnings = AN.earningsReactions(bars, evs.slice(0, 16));
    // Form 4 with cache
    const cachePath = path.join(CACHE, sym + '.json');
    const cache = readJson(cachePath, { filings: {} });
    const since = new Date(); since.setMonth(since.getMonth() - cfg.insiderMonths); const sinceStr = since.toISOString().slice(0, 10);
    const list = SEC.form4Filings(sub).filter((f) => f.filingDate >= sinceStr);
    let fetched = 0, failed = 0;
    for (const f of list) {
      if (cache.filings[f.accession]) continue;
      if (fetched >= cfg.form4MaxPerRun) break;
      const acc = f.accession.replace(/-/g, '');
      try {
        const r = await sec(`https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${f.primaryDocument}`);
        fetched++;
        if (r.ok) cache.filings[f.accession] = { filingDate: f.filingDate, accession: f.accession, parsed: SEC.parseForm4(r.text) };
        else { failed++; cache.filings[f.accession] = { filingDate: f.filingDate, accession: f.accession, parsed: null, error: 'HTTP ' + r.status }; }
      } catch (e) { failed++; out.errors.push('form4 ' + f.accession + ': ' + e.message); }
    }
    for (const k of Object.keys(cache.filings)) if (cache.filings[k].filingDate < sinceStr) delete cache.filings[k]; // prune
    writeJson(cachePath, cache);
    const pending = list.filter((f) => !cache.filings[f.accession]).length;
    out.insiders = Object.assign(SEC.summarizeInsiders(Object.values(cache.filings), sinceStr), { filingsInWindow: list.length, parsed: Object.values(cache.filings).filter((x) => x.parsed).length, pending, fetchedThisRun: fetched, failed });
  }
  return out;
}

// ---------- macro ----------
async function fetchMacro(prev) {
  const m = Object.assign({ dgs10: [], dgs2: [], vix: [] }, prev || {}); m.errors = [];
  for (const [k, id] of [['dgs10', 'DGS10'], ['dgs2', 'DGS2']]) {
    try { const r = await http(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`); if (r.ok) { const s = parseFredCsv(r.text); if (s.length) m[k] = s.slice(-1300); } else m.errors.push(id + ' HTTP ' + r.status); }
    catch (e) { m.errors.push(id + ': ' + e.message); }
  }
  try { const r = await http('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'); if (r.ok) { const s = parseVixCsv(r.text); if (s.length) m.vix = s.slice(-1300); } else m.errors.push('VIX HTTP ' + r.status); }
  catch (e) { m.errors.push('VIX: ' + e.message); }
  m.updatedAt = new Date().toISOString();
  return m;
}

// ---------- main ----------
(async () => {
  const symbols = [...new Set([cfg.bench, ...cfg.symbols].map((s) => s.toUpperCase()))];
  const index = { updatedAt: new Date().toISOString(), bench: cfg.bench.toUpperCase(), symbols: [], errors: [] };
  for (const sym of symbols) {
    const file = path.join(DATA, sym + '.json');
    const prev = readJson(file, null);
    const rec = { symbol: sym, updatedAt: new Date().toISOString(), errors: [] };
    log('price', sym);
    const p = await fetchBars(sym);
    let bars = prev?.bars ? prev.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })) : [];
    if (p.bars.length) { bars = mergeBars(bars, p.bars); rec.priceSource = p.source; } else { rec.errors.push('price: ' + p.error + (bars.length ? ' (kept previous bars)' : '')); rec.priceSource = prev?.priceSource || null; }
    const dp = dropPartialBar(bars);
    if (dp.dropped) { bars = dp.bars; rec.partialBarDropped = dp.dropped; log('dropped in-progress bar', sym, dp.dropped); }
    bars = bars.slice(-cfg.keepBars);
    if (!bars.length) { index.symbols.push({ symbol: sym, error: rec.errors.join('; ') }); continue; }
    rec.bars = bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
    rec.lastDate = bars[bars.length - 1].t; rec.lastClose = bars[bars.length - 1].c;
    rec.drawdown = AN.drawdowns(bars, 10);
    if (sym !== index.bench && !cfg.secSkip.includes(sym)) {
      log('splits', sym);
      const sp = await fetchSplits(sym);
      if (sp.error) rec.errors.push('splits: ' + sp.error + '（EPSの分割調整ができないためPER分布は出しません）');
      rec.splits = sp.splits;
      log('sec', sym);
      try {
        rec.sec = sp.error ? Object.assign(await fetchSec(sym, bars, prev, []), { peBand: { note: '分割履歴を取得できなかったためPER分布は算出していません' } }) : await fetchSec(sym, bars, prev, sp.splits);
        rec.errors.push(...rec.sec.errors.map((e) => 'sec: ' + e));
      } catch (e) { rec.errors.push('sec: ' + e.message); rec.sec = prev?.sec || null; }
    } else if (sym !== index.bench) rec.sec = { skipped: true, errors: [] };
    writeJson(file, rec);
    index.symbols.push({ symbol: sym, name: rec.sec?.name || null, lastDate: rec.lastDate, lastClose: rec.lastClose, priceSource: rec.priceSource, splits: (rec.splits || []).length, insiderBuys: rec.sec?.insiders?.buyCount ?? null, errors: rec.errors });
    log('done', sym, rec.lastDate, rec.priceSource, rec.errors.length ? rec.errors : '');
  }
  log('macro');
  const macro = await fetchMacro(readJson(path.join(DATA, 'macro.json'), null));
  writeJson(path.join(DATA, 'macro.json'), macro);
  index.macro = { dgs10: macro.dgs10.slice(-1)[0] || null, dgs2: macro.dgs2.slice(-1)[0] || null, vix: macro.vix.slice(-1)[0] || null, errors: macro.errors };
  writeJson(path.join(DATA, 'index.json'), index);
  log('finished', index.symbols.length, 'symbols');
})().catch((e) => { console.error(e); process.exit(1); });
