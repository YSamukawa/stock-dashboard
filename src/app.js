// ===================== App =====================
const $ = (id) => document.getElementById(id);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
  keys() { try { return Object.keys(localStorage); } catch { return []; } },
};
const DEFAULTS = { tvPriority: true, source: 'auto', apiKey: '', symbols: ['AVGO', 'NVDA', 'GOOG', 'FCX', 'MU', 'MSFT', 'CIEN', 'QQQ', 'GLD', 'TLT'], bench: 'SPY', outputsize: 1000, fund: true, ttlHours: 12 };
let settings = Object.assign({}, DEFAULTS, LS.get('msc:settings', {}));
const todayStr = () => new Date().toISOString().slice(0, 10);

// ---------- rate-limited request queue (Twelve Data: 8 credits/min on free) ----------
const RL = { maxPerMin: 7, stamps: [], queue: [], running: false, credits: LS.get('msc:credits:' + todayStr(), 0) };
function bumpCredits(n = 1) { RL.credits += n; LS.set('msc:credits:' + todayStr(), RL.credits); updateStatus(); }
function enqueue(fn, prio = 0) {
  return new Promise((resolve, reject) => {
    RL.queue.push({ fn, resolve, reject, prio });
    RL.queue.sort((a, b) => b.prio - a.prio);
    pump();
  });
}
async function pump() {
  if (RL.running) return;
  RL.running = true;
  while (RL.queue.length) {
    const now = Date.now();
    RL.stamps = RL.stamps.filter((t) => now - t < 61000);
    if (settings.apiKey !== 'MOCK' && RL.stamps.length >= RL.maxPerMin) {
      const wait = 61000 - (now - RL.stamps[0]) + 200;
      updateStatus(`レート制限待ち ${Math.ceil(wait / 1000)}s（残 ${RL.queue.length}件）`);
      await sleep(wait);
      continue;
    }
    const job = RL.queue.shift();
    RL.stamps.push(Date.now());
    updateStatus();
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
  }
  RL.running = false;
  updateStatus();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Twelve Data access with cache ----------
const TD = 'https://api.twelvedata.com/';
class ApiError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
async function tdFetch(path, params) {
  if (settings.apiKey === 'MOCK') return mockFetch(path, params);
  const q = new URLSearchParams(Object.assign({}, params, { apikey: settings.apiKey }));
  let res;
  try { res = await fetch(TD + path + '?' + q.toString()); }
  catch (e) { throw new ApiError('network', 'ネットワーク/CORSエラー: ' + e.message); }
  const j = await res.json().catch(() => ({}));
  if (j && j.status === 'error') throw new ApiError(j.code, j.message || 'API error');
  if (!res.ok) throw new ApiError(res.status, 'HTTP ' + res.status);
  return j;
}
function cacheKey(kind, sym) { return `msc:${kind}:${sym.toUpperCase()}`; }
async function cached(kind, sym, ttlMs, loader, force = false, prio = 0) {
  const k = cacheKey(kind, sym);
  const hit = LS.get(k, null);
  if (!force && hit && Date.now() - hit.at < ttlMs) return hit.data;
  if (!force && hit && hit.err && Date.now() - hit.at < 24 * 3600e3) throw new ApiError(hit.err.code, hit.err.msg); // don't hammer plan-restricted endpoints
  try {
    const data = await enqueue(loader, prio);
    bumpCredits(1);
    if (!LS.set(k, { at: Date.now(), data })) console.warn('localStorage full; not cached', k);
    return data;
  } catch (e) {
    if (e instanceof ApiError && e.code !== 429 && e.code !== 'network') { bumpCredits(1); LS.set(k, { at: Date.now(), err: { code: e.code, msg: e.message } }); }
    if (e.code === 429) { await sleep(60000); return cached(kind, sym, ttlMs, loader, force, prio); }
    throw e;
  }
}
const ttlTs = () => (settings.ttlHours || 12) * 3600e3;
const TTL_FUND = 7 * 24 * 3600e3;
function getSeries(sym, force = false, prio = 0) {
  return cached('ts', sym, ttlTs(), () => tdFetch('time_series', { symbol: sym, interval: '1day', outputsize: settings.outputsize }), force, prio)
    .then((j) => { const bars = MSA.parseTwelveData(j.values); if (!bars.length) throw new ApiError('nodata', 'データなし'); return { bars, meta: j.meta || {} }; });
}
const getQuote = (sym, f) => cached('quote', sym, TTL_FUND, () => tdFetch('quote', { symbol: sym }), f, -1);
const getStats = (sym, f) => cached('stats', sym, TTL_FUND, () => tdFetch('statistics', { symbol: sym }), f, -1);
const getEarnings = (sym, f) => cached('earn', sym, TTL_FUND, () => tdFetch('earnings', { symbol: sym }), f, -1);

// ---------- mock data (apiKey = MOCK) ----------
function mockFetch(path, p) {
  const sym = p.symbol; let s = 0; for (const ch of sym) s = (s * 31 + ch.charCodeAt(0)) % 233280;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  if (path === 'time_series') {
    const vals = []; const d = new Date(); d.setUTCDate(d.getUTCDate() - 1500); let px = 50 + rnd() * 300;
    const trend = (rnd() - 0.4) * 0.002;
    while (vals.length < p.outputsize) {
      d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const k = vals.length, cyc = Math.sin(k / 90) * 0.003;
      px *= 1 + trend + cyc + (rnd() - 0.5) * 0.03;
      const o = px * (1 + (rnd() - 0.5) * 0.01), c = px, h = Math.max(o, c) * (1 + rnd() * 0.012), l = Math.min(o, c) * (1 - rnd() * 0.012);
      vals.push({ datetime: d.toISOString().slice(0, 10), open: o.toFixed(2), high: h.toFixed(2), low: l.toFixed(2), close: c.toFixed(2), volume: String(Math.round(2e6 * (0.4 + rnd() * 1.4))) });
    }
    return new Promise((r) => setTimeout(() => r({ meta: { symbol: sym, exchange: 'MOCK', type: 'Common Stock', currency: 'USD' }, values: vals.reverse() }), 120));
  }
  if (path === 'quote') return { name: sym + ' Inc. (mock)', exchange: 'MOCK', average_volume: '3000000' };
  if (path === 'statistics') return { statistics: { valuations_metrics: { market_capitalization: Math.round(rnd() * 3e12), trailing_pe: (10 + rnd() * 40).toFixed(1), price_to_book_mrq: (2 + rnd() * 20).toFixed(1) }, stock_statistics: { shares_outstanding: Math.round(rnd() * 5e9), float_shares: Math.round(rnd() * 4e9) } } };
  if (path === 'earnings') {
    const e = []; const d = new Date(); d.setUTCMonth(d.getUTCMonth() + 1); let eps = 1 + rnd() * 3;
    for (let i = 0; i < 10; i++) { e.push({ date: d.toISOString().slice(0, 10), time: 'After Hours', eps_estimate: +(eps * 0.97).toFixed(2), eps_actual: i === 0 ? null : +eps.toFixed(2) }); d.setUTCMonth(d.getUTCMonth() - 3); eps *= 1 - (rnd() - 0.3) * 0.15; }
    return { earnings: e };
  }
  throw new ApiError(404, 'mock: unknown ' + path);
}

// ---------- state ----------
const state = { mode: 'api', repoIndex: null, healthMsg: null, tv: { datasets: {}, snapshots: [], overlays: new Set() }, sym: null, data: {}, bench: null, tf: 'day', log: true, ind: 'none', sort: { k: 'symbol', dir: 1 }, ma: [true, true, true], rs: true, bb: false, zone: true, peb: false, bz: false, brWidth: +(LS.get('msc:brWidth', 1)) || 1 };
// data[sym] = {bars, meta, quote, stats, earnings, fundErr, summary, rsRaw, ad, eps, base, pivot}

function fmt(n, d = 2) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtPct(n, d = 2) { return n == null || isNaN(n) ? '—' : (n > 0 ? '+' : '') + fmt(n, d) + '%'; }
function fmtBig(n) { if (n == null || isNaN(n)) return '—'; const a = Math.abs(n); return a >= 1e12 ? fmt(n / 1e12, 2) + 'T' : a >= 1e9 ? fmt(n / 1e9, 2) + 'B' : a >= 1e6 ? fmt(n / 1e6, 1) + 'M' : a >= 1e3 ? fmt(n / 1e3, 0) + 'K' : fmt(n, 0); }
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
function updateStatus(msg) {
  if (state.mode === 'repo' && !msg) return;
  const q = RL.queue.length; $('status').textContent = msg || (q ? `取得中… 残 ${q}件 / 本日 ${RL.credits} クレジット` : `本日 ${RL.credits} クレジット使用（目安上限800）`);
}
function renderMacro(ix) {
  const m = ix.macro || {}; const el = $('macro'); if (!el) return;
  const spread = m.dgs10 && m.dgs2 ? (m.dgs10.v - m.dgs2.v).toFixed(2) : null;
  el.innerHTML = [m.dgs10 ? `US10Y <b>${fmt(m.dgs10.v)}%</b>` : '', m.dgs2 ? `US2Y <b>${fmt(m.dgs2.v)}%</b>` : '', spread != null ? `10-2 <b class="${cls(+spread)}">${spread}</b>` : '', m.vix ? `VIX <b>${fmt(m.vix.v, 1)}</b> <span class="note">${m.vix.t}</span>` : ''].filter(Boolean).join(' · ');
}
function showErr(m) { const e = $('err'); if (!m) { e.style.display = 'none'; return; } e.style.display = 'block'; e.textContent = m; }


// ---------- TradingView local import (IndexedDB only — never sent anywhere) ----------
const TVDB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('msc-tv', 1); r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('datasets')) db.createObjectStore('datasets', { keyPath: 'id' }); if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async tx(store, mode, fn) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction(store, mode); const st = t.objectStore(store); const out = fn(st); t.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : out); }; t.onerror = () => rej(t.error); }); },
  all(store) { return this.tx(store, 'readonly', (st) => st.getAll()); },
  put(store, obj) { return this.tx(store, 'readwrite', (st) => st.put(obj)); },
  del(store, key) { return this.tx(store, 'readwrite', (st) => st.delete(key)); },
};
async function tvLoadAll() {
  try {
    const ds = await TVDB.all('datasets'); state.tv.datasets = {}; for (const d of ds) state.tv.datasets[d.symbol] = d;
    state.tv.snapshots = await TVDB.all('snapshots');
  } catch (e) { console.warn('IndexedDB unavailable', e); state.tv.datasets = {}; state.tv.snapshots = []; }
}
function tvFor(sym) { const d = state.tv.datasets[(sym || '').toUpperCase()]; return d && d.tf === '1D' ? d : null; }
function applyTv(sym) {
  const d = state.data[sym]; if (!d) return;
  if (d.rawBars === undefined) d.rawBars = d.bars;
  const t = tvFor(sym);
  d.tv = t || null;
  d.bars = t && settings.tvPriority ? TV.mergeBars(d.rawBars || [], t.rows) : d.rawBars;
  if (sym === settings.bench.toUpperCase()) state.bench = d.bars;
}
async function tvImportFile(file, symbolOverride) {
  const text = await file.text();
  const parsed = TV.parse(text);
  const g = TV.guessSymbol(file.name);
  const symbol = (symbolOverride || g.symbol || '').toUpperCase();
  if (!symbol) throw new Error('銘柄コードをファイル名から判定できません。銘柄欄に入力してください: ' + file.name);
  const rec = { id: symbol + '|' + parsed.tf, symbol, tf: parsed.tf, fileName: file.name, uploadedAt: new Date().toISOString(), columns: parsed.columns, classes: TV.classify(parsed), rows: parsed.rows, from: parsed.from, to: parsed.to, estHistory: TV.estimateHistory(parsed) };
  await TVDB.put('datasets', rec);
  const le = TV.latestEstimates(parsed);
  let snapNote = '推定値列なし';
  if (le) {
    const last = state.tv.snapshots.filter((x) => x.symbol === symbol).sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))[0];
    if (last && last.asOf === le.asOf && JSON.stringify(last.values) === JSON.stringify(le.values)) snapNote = '推定値は前回スナップショットと同一（記録せず）';
    else { await TVDB.put('snapshots', { symbol, uploadedAt: rec.uploadedAt, asOf: le.asOf, values: le.values, fileName: file.name }); snapNote = '推定値スナップショットを記録'; }
  }
  await tvLoadAll();
  if (state.data[symbol]) { applyTv(symbol); analyze(symbol); universeRanks(); renderList(); if (state.sym === symbol) renderAll(); }
  return { symbol, tf: parsed.tf, bars: parsed.rows.length, from: parsed.from, to: parsed.to, cols: parsed.columns.length, snapNote };
}
async function tvDelete(id) { await TVDB.del('datasets', id); await tvLoadAll(); for (const s of Object.keys(state.data)) { applyTv(s); analyze(s); } universeRanks(); renderList(); renderAll(); renderTvModal(); }
async function tvDeleteSnapshot(id) { await TVDB.del('snapshots', id); await tvLoadAll(); renderTvModal(); if (state.sym) renderEval(); }
function renderTvModal() {
  const ds = Object.values(state.tv.datasets).sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  $('tvList').innerHTML = ds.length ? `<table class="eps"><tr><th>銘柄</th><th>足</th><th>期間</th><th>本数</th><th>列</th><th>取込日時</th><th></th></tr>${ds.map((d) => `<tr><td class="sym">${d.symbol}</td><td>${d.tf}</td><td>${d.from} 〜 ${d.to}</td><td>${d.rows.length}</td><td>${d.columns.length}</td><td>${new Date(d.uploadedAt).toLocaleString('ja-JP')}</td><td><button data-del="${d.id}">削除</button></td></tr>`).join('')}</table>` : '<div class="note">取込済みデータはありません。</div>';
  const sn = [...state.tv.snapshots].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  $('tvSnaps').innerHTML = sn.length ? `<table class="eps"><tr><th>銘柄</th><th>データ基準日</th><th>取込日時</th><th>値</th><th></th></tr>${sn.slice(0, 30).map((x) => `<tr><td class="sym">${x.symbol}</td><td>${x.asOf}</td><td>${new Date(x.uploadedAt).toLocaleString('ja-JP')}</td><td>${Object.entries(x.values).map(([k, v]) => k.replace(/ Estimate/i, '') + ' ' + (Math.abs(v) > 1e6 ? fmtBig(v) : fmt(v, 3))).join(' / ')}</td><td><button data-delsnap="${x.id}">削除</button></td></tr>`).join('')}</table>` : '<div class="note">推定値のスナップショットはまだありません。取り込むたびに最終行の推定値を日付付きで記録し、前回との差（修正方向）を評価パネルに表示します。</div>';
  $('tvList').querySelectorAll('button[data-del]').forEach((b) => (b.onclick = () => tvDelete(b.dataset.del)));
  $('tvSnaps').querySelectorAll('button[data-delsnap]').forEach((b) => (b.onclick = () => tvDeleteSnapshot(+b.dataset.delsnap)));
  $('tvPriority').checked = !!settings.tvPriority;
}
async function tvHandleFiles(files) {
  const log = $('tvLog'); const symOverride = $('tvSym').value.trim().toUpperCase();
  for (const f of files) {
    try { const r = await tvImportFile(f, files.length === 1 ? symOverride : ''); log.innerHTML = `<div class="pos">✓ ${f.name} → ${r.symbol} ${r.tf} ${r.bars}本（${r.from}〜${r.to}）、追加列${r.cols}、${r.snapNote}</div>` + log.innerHTML; }
    catch (e) { log.innerHTML = `<div class="neg">✗ ${f.name}: ${e.message}</div>` + log.innerHTML; }
  }
  $('tvSym').value = ''; renderTvModal(); renderTvControls();
}
function renderTvControls() {
  const t = tvFor(state.sym); const box = $('tvChips'); const sel = $('indSel');
  [...sel.querySelectorAll('option[data-tv]')].forEach((o) => o.remove());
  if (!t) { box.innerHTML = ''; if (state.ind.startsWith('tv:')) state.ind = 'none'; return; }
  const ov = t.classes.filter((c) => c.kind === 'overlay'), pn = t.classes.filter((c) => c.kind === 'pane');
  box.innerHTML = ov.map((c, i) => `<label class="sw" title="TradingView列"><input type="checkbox" data-tvk="${c.key}" ${state.tv.overlays.has(c.key) ? 'checked' : ''}><i style="background:${TV_COLORS[i % TV_COLORS.length]}"></i><span>TV:${c.name}</span></label>`).join('');
  box.querySelectorAll('input[data-tvk]').forEach((inp) => inp.addEventListener('change', () => { if (inp.checked) state.tv.overlays.add(inp.dataset.tvk); else state.tv.overlays.delete(inp.dataset.tvk); renderChart(); }));
  for (const c of pn) { const o = document.createElement('option'); o.value = 'tv:' + c.key; o.textContent = 'TV: ' + c.name; o.dataset.tv = '1'; sel.appendChild(o); }
  sel.value = state.ind;
}
const TV_COLORS = ['#e67e22', '#16a085', '#8e44ad', '#c0392b', '#2980b9', '#7f8c8d'];
function tvColumnSeries(t, key, times) { // value at each aggregated bar's date (last day in bucket)
  const m = new Map(t.rows.map((r) => [r.t, r.x[key]]));
  return times.map((tm) => { const v = m.get(tm); return typeof v === 'number' ? { time: tm, value: v } : { time: tm }; });
}

// ---------- analytics per symbol ----------
function analyze(sym) {
  const d = state.data[sym]; if (!d || !d.bars) return;
  d.summary = MSA.summary(d.bars);
  d.rsRaw = MSA.rsRaw(d.bars);
  d.ad = MSA.adRating(d.bars);
  d.weekly = MSA.aggregate(d.bars, 'week');
  d.base = MSA.detectBase(d.weekly);
  d.pivot = MSA.pivot(d.bars, 60);
  d.feats = d.bars.length >= 220 ? MSB.features(d.bars, state.bench) : null; d.featsWithBench = !!state.bench;
  if (d.repo) {
    const q = d.repo.sec?.qeps || [];
    d.eps = q.length ? MSA.epsGrowth(q.map((x) => ({ date: x.end, eps_actual: x.eps }))) : null;
    const evs = (d.repo.sec?.earnings?.events || []).filter((e) => !e.pending);
    if (evs.length) { const last = new Date(evs[0].reactionDate); last.setUTCDate(last.getUTCDate() + 91); const est = last.toISOString().slice(0, 10); d.next = est >= todayStr() ? { date: est, time: '推定(前回+91日)' } : null; } else d.next = null;
  } else {
    d.eps = d.earnings ? MSA.epsGrowth(d.earnings.earnings) : null;
    d.next = d.earnings ? MSA.nextEarnings(d.earnings.earnings, todayStr()) : null;
  }
}
function universeRanks() {
  const syms = Object.keys(state.data).filter((s) => state.data[s].bars && s !== settings.bench.toUpperCase());
  for (const s of syms) { const d = state.data[s]; if (d.feats && state.bench && !d.featsWithBench) { d.feats = MSB.features(d.bars, state.bench); d.featsWithBench = true; } }
  const rsU = syms.map((s) => state.data[s].rsRaw), epsU = syms.map((s) => state.data[s].eps?.raw ?? null);
  for (const s of syms) { const d = state.data[s]; d.rsPct = MSA.percentile(d.rsRaw, rsU); d.epsPct = MSA.percentile(d.eps?.raw ?? null, epsU); }
  return syms.length;
}

// ---------- loading ----------
async function fetchRepoJson(rel) { const r = await fetch(rel + '?v=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + rel); return r.json(); }
async function loadSymbolRepo(sym) {
  sym = sym.toUpperCase();
  const d = (state.data[sym] = state.data[sym] || {});
  try {
    const rec = await fetchRepoJson('data/' + sym + '.json');
    d.repo = rec; d.rawBars = rec.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })); d.bars = d.rawBars; d.meta = { exchange: rec.priceSource ? 'src: ' + rec.priceSource : '' }; d.err = rec.errors?.length ? rec.errors.join(' / ') : null;
    applyTv(sym);
    d.quote = { name: rec.sec?.name || '' };
  } catch (e) { d.err = e.message; d.bars = null; }
  analyze(sym); universeRanks(); renderList();
  if (state.sym === sym) renderAll(); else if (state.data[state.sym]?.bars) renderEval();
  return d;
}
async function loadSymbol(sym, force = false, prio = 0) {
  if (state.mode === 'repo') return loadSymbolRepo(sym);
  sym = sym.toUpperCase();
  const d = (state.data[sym] = state.data[sym] || {});
  try {
    const r = await getSeries(sym, force, prio);
    d.rawBars = r.bars; d.bars = r.bars; d.meta = r.meta; d.err = null;
  } catch (e) { d.err = e.message; d.bars = null; d.rawBars = null; }
  applyTv(sym);
  analyze(sym);
  if (settings.fund && d.bars && sym !== settings.bench.toUpperCase()) {
    d.fundErr = {};
    const tasks = [['quote', getQuote], ['stats', getStats], ['earnings', getEarnings]].map(([k, f]) =>
      f(sym, force).then((v) => { d[k] = v; }).catch((e) => { d.fundErr[k] = e.message; }).then(() => { analyze(sym); universeRanks(); renderList(); if (state.sym === sym) renderHeader(); }));
    Promise.all(tasks).then(() => { if (state.sym === sym) renderEval(); });
  }
  universeRanks(); renderList();
  if (state.sym === sym) renderAll(); else if (state.data[state.sym]?.bars) renderEval();
  return d;
}
async function ensureBench(force = false) {
  const b = settings.bench.toUpperCase();
  if (state.mode === 'repo') { const d = await loadSymbolRepo(b); state.bench = d.bars; return; }
  try { const r = await getSeries(b, force, 5); state.data[b] = Object.assign(state.data[b] || {}, { rawBars: r.bars, bars: r.bars }); applyTv(b); state.bench = state.data[b].bars; } catch (e) { state.bench = null; console.warn('bench', e); }
}
async function detectMode() {
  if (settings.source === 'api') { state.mode = 'api'; return; }
  if (location.protocol === 'file:' && settings.source !== 'repo') { state.mode = 'api'; return; }
  try { state.repoIndex = await fetchRepoJson('data/index.json'); state.mode = 'repo'; }
  catch (e) { state.repoIndex = null; state.mode = 'api'; if (settings.source === 'repo') showErr('data/index.json を読めません（' + e.message + '）。GitHub Pages上で開くか、設定でデータ元を「API直接」にしてください。'); }
}
async function boot(force = false) {
  await detectMode(); await tvLoadAll();
  if (state.mode === 'repo') {
    const ix = state.repoIndex; settings.bench = ix.bench || settings.bench;
    settings.symbols = ix.symbols.map((s) => s.symbol).filter((s) => s !== ix.bench);
    renderMacro(ix);
    const ageH = (Date.now() - Date.parse(ix.updatedAt)) / 3600e3;
    const stale = ageH > 96; // a long weekend is fine; beyond that the daily job has stopped
    updateStatus(`データ更新: ${new Date(ix.updatedAt).toLocaleString('ja-JP')}${ix.mock ? '（モック）' : ''}${stale ? ` ⚠ ${Math.floor(ageH / 24)}日前` : ''}`);
    const hp = (ix.health && ix.health.problems) || [];
    if (hp.length || stale) state.healthMsg = 'データ取得に問題があります: ' + [...hp, stale ? `最終更新から${Math.floor(ageH / 24)}日経過（自動更新が止まっている可能性）` : ''].filter(Boolean).join(' / ');
    else state.healthMsg = null;
    $('footData').textContent = 'データ: Stooq/Yahoo（株価）・SEC EDGAR（財務/8-K/Form 4）・FRED・Cboe — GitHub Actionsで日次更新';
  } else if (!settings.apiKey) { openSettings(); return; }
  showErr(state.healthMsg || null); // a stale/broken feed must stay visible, not be cleared on boot
  const first = state.sym || settings.symbols[0];
  state.sym = first;
  await Promise.all([ensureBench(force), loadSymbol(first, force, 10)]);
  renderAll();
  for (const s of settings.symbols) if (s.toUpperCase() !== first.toUpperCase()) loadSymbol(s, force, 0);
}
function selectSymbol(sym) {
  sym = sym.trim().toUpperCase(); if (!sym) return;
  state.sym = sym; renderList();
  if (state.data[sym]?.bars) renderAll(); else { renderHeader(); loadSymbol(sym, false, 10); }
}

// ---------- charts (Lightweight Charts v4) ----------
const LW = window.LightweightCharts;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let charts = {}, series = {};
function chartOpts(el) {
  return {
    layout: { background: { type: 'solid', color: css('--panel') }, textColor: css('--ink2'), fontSize: 11, fontFamily: css('--font'), attributionLogo: false },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--line'), minimumWidth: 72, scaleMargins: { top: 0.06, bottom: 0.28 } },
    timeScale: { borderColor: css('--line'), rightOffset: 6, barSpacing: 6, minBarSpacing: 2 },
    crosshair: { mode: LW.CrosshairMode.Normal, vertLine: { labelBackgroundColor: css('--accent') }, horzLine: { labelBackgroundColor: css('--accent') } },
    autoSize: true, handleScroll: true, handleScale: true,
  };
}
function buildCharts() {
  for (const k in charts) charts[k].remove();
  charts = {}; series = {};
  charts.price = LW.createChart($('cPrice'), chartOpts());
  charts.vol = LW.createChart($('cVol'), Object.assign(chartOpts(), { rightPriceScale: { borderColor: css('--line'), minimumWidth: 72, scaleMargins: { top: 0.15, bottom: 0 } } }));
  charts.ind = LW.createChart($('cInd'), Object.assign(chartOpts(), { rightPriceScale: { borderColor: css('--line'), minimumWidth: 72, scaleMargins: { top: 0.1, bottom: 0.1 } } }));
  const up = css('--up'), dn = css('--dn');
  series.candle = charts.price.addCandlestickSeries({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn, priceLineVisible: true, lastValueVisible: true });
  series.ma1 = charts.price.addLineSeries({ color: css('--ma21'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.ma2 = charts.price.addLineSeries({ color: css('--ma50'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.ma3 = charts.price.addLineSeries({ color: css('--ma200'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.bbU = charts.price.addLineSeries({ color: css('--muted'), lineWidth: 1, lineStyle: LW.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.bbL = charts.price.addLineSeries({ color: css('--muted'), lineWidth: 1, lineStyle: LW.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.rs = charts.price.addLineSeries({ color: css('--rs'), lineWidth: 1, priceScaleId: 'rs', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  charts.price.priceScale('rs').applyOptions({ visible: false, scaleMargins: { top: 0.62, bottom: 0.04 } });
  series.vol = charts.vol.addHistogramSeries({ priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
  series.volMa = charts.vol.addLineSeries({ color: css('--ma50'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  series.ind1 = charts.ind.addLineSeries({ color: css('--accent'), lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
  series.ind2 = charts.ind.addLineSeries({ color: css('--ma50'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  series.indH = charts.ind.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  // sync time scales
  const all = Object.values(charts); let syncing = false;
  all.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (syncing || !r || (r.from < -50 && r.to < 10)) return; /* ignore the empty-chart default range */ syncing = true; all.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(r)); syncing = false; }));
  all.forEach((c) => c.subscribeCrosshairMove((p) => { onCrosshair(c, p); }));
}
function seriesData(arr, times) { const out = []; for (let i = 0; i < arr.length; i++) out.push(arr[i] != null ? { time: times[i], value: arr[i] } : { time: times[i] }); return out; } // whitespace items keep every chart on the same logical index
let view = null; // current computed view for labels
function renderChart() {
  const d = state.data[state.sym]; if (!d || !d.bars) { view = null; return; }
  const bars = MSA.aggregate(d.bars, state.tf);
  const times = bars.map((b) => b.t), closes = bars.map((b) => b.c);
  const isW = state.tf !== 'day';
  const maN = isW ? [10, 40, null] : [21, 50, 200];
  const ma = maN.map((n) => (n ? MSA.sma(closes, n) : closes.map(() => null)));
  const bb = MSA.bollinger(closes, 20, 2);
  const bench = state.bench ? MSA.aggregate(state.bench, state.tf) : null;
  const rs = bench ? MSA.rsLine(bars, bench) : bars.map(() => null);
  const volMa = MSA.sma(bars.map((b) => b.v), isW ? 10 : 50);
  view = { bars, times, maN, ma, bb, rs, volMa };
  series.candle.setData(bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })));
  series.ma1.setData(state.ma[0] ? seriesData(ma[0], times) : []);
  series.ma2.setData(state.ma[1] ? seriesData(ma[1], times) : []);
  series.ma3.setData(state.ma[2] && maN[2] ? seriesData(ma[2], times) : []);
  series.bbU.setData(state.bb ? seriesData(bb.up, times) : []); series.bbL.setData(state.bb ? seriesData(bb.lo, times) : []);
  series.rs.setData(state.rs ? seriesData(rs, times) : []);
  const up = css('--up'), dn = css('--dn');
  // TradingView overlay columns
  (series.tvo || []).forEach((sr) => charts.price.removeSeries(sr)); series.tvo = [];
  const tvd = tvFor(state.sym); view.tv = tvd; view.tvOv = [];
  if (tvd) { const ov = tvd.classes.filter((c) => c.kind === 'overlay'); ov.forEach((c, i) => { if (!state.tv.overlays.has(c.key)) return; const sr = charts.price.addLineSeries({ color: TV_COLORS[i % TV_COLORS.length], lineWidth: 1, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); sr.setData(tvColumnSeries(tvd, c.key, times)); series.tvo.push(sr); view.tvOv.push({ key: c.key, name: c.name, color: TV_COLORS[i % TV_COLORS.length] }); }); }
  series.vol.setData(bars.map((b, i) => ({ time: b.t, value: b.v, color: i > 0 && b.c < bars[i - 1].c ? dn : up })));
  series.volMa.setData(seriesData(volMa, times));
  charts.price.priceScale('right').applyOptions({ mode: state.log ? LW.PriceScaleMode.Logarithmic : LW.PriceScaleMode.Normal });
  // price lines: pivot / buy zone / 52wk high
  (series.pls || []).forEach((pl) => series.candle.removePriceLine(pl)); series.pls = [];
  series.candle.setMarkers([]);
  if (state.zone) {
    const b = d.base && d.base.status !== 'none' ? d.base : null; const pv = b ? b.pivot : d.pivot?.pivot;
    if (pv) {
      series.pls.push(series.candle.createPriceLine({ price: pv, color: up, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, title: 'Pivot' }));
      series.pls.push(series.candle.createPriceLine({ price: pv * 1.05, color: up, lineWidth: 1, lineStyle: LW.LineStyle.Dotted, title: '+5%' }));
    }
    if (d.summary) series.pls.push(series.candle.createPriceLine({ price: d.summary.hi52, color: css('--muted'), lineWidth: 1, lineStyle: LW.LineStyle.SparseDotted, title: '52W H' }));
    if (state.bz && d.bz) {
      for (const c of d.bz.thick.slice(0, 3)) { series.pls.push(series.candle.createPriceLine({ price: c.high, color: css('--good'), lineWidth: 1, lineStyle: LW.LineStyle.Solid, title: `底値帯 ${c.count}件` })); if (c.high !== c.low) series.pls.push(series.candle.createPriceLine({ price: c.low, color: css('--good'), lineWidth: 1, lineStyle: LW.LineStyle.Solid, axisLabelVisible: false })); }
      for (const l of d.bz.levels.filter((l) => !d.bz.thick.some((c) => c.items.includes(l))).slice(0, 4)) series.pls.push(series.candle.createPriceLine({ price: l.price, color: css('--good'), lineWidth: 1, lineStyle: LW.LineStyle.SparseDotted, title: l.src.split('（')[0].slice(0, 10) }));
    }
    if (d.repo?.sec?.peBand?.band && state.peb) {
      const pb = d.repo.sec.peBand;
      for (const [k, l] of [['p25', 'PER25%'], ['p50', 'PER中央'], ['p75', 'PER75%']]) series.pls.push(series.candle.createPriceLine({ price: pb.band[k], color: css('--warn'), lineWidth: 1, lineStyle: k === 'p50' ? LW.LineStyle.Solid : LW.LineStyle.Dotted, title: l }));
    }
    const marks = [];
    if (d.repo?.sec?.earnings) for (const e of d.repo.sec.earnings.events) if (!e.pending && e.tradeDate >= times[0]) marks.push({ time: e.tradeDate, position: 'belowBar', color: e.reactionPct >= 0 ? up : dn, shape: 'circle', text: 'E', size: 0.8 });
    if (b) marks.push({ time: b.leftDate, position: 'aboveBar', color: css('--ink2'), shape: 'arrowDown', text: 'L' }, { time: b.lowDate, position: 'belowBar', color: css('--ink2'), shape: 'arrowUp', text: `-${b.depthPct.toFixed(0)}%` });
    // map marker dates to the aggregated bar containing them (one marker per bar keeps ordering valid)
    const seen = new Set();
    series.candle.setMarkers(marks.map((m) => ({ ...m, time: times.find((t) => t >= m.time) || times[times.length - 1] })).sort((x, y) => (x.time < y.time ? -1 : 1)).filter((m) => (seen.has(m.time + m.position) ? false : seen.add(m.time + m.position))));
  }
  // lower indicator
  $('charts').classList.toggle('ind', state.ind !== 'none');
  series.ind1.setData(seriesData(closes, times)); series.ind1.applyOptions({ visible: state.ind !== 'none' }); series.ind2.setData([]); series.indH.setData([]); /* hidden series keeps the pane's time scale populated */
  (series.ipl || []).forEach((pl) => series.ind1.removePriceLine(pl)); series.ipl = [];
  if (state.ind === 'rsi') { const r = MSA.rsi(closes, 14); series.ind1.setData(seriesData(r, times)); series.ipl.push(series.ind1.createPriceLine({ price: 70, color: css('--muted'), lineStyle: LW.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false }), series.ind1.createPriceLine({ price: 30, color: css('--muted'), lineStyle: LW.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false })); view.ind = { rsi: r }; }
  else if (state.ind === 'macd') { const m = MSA.macd(closes); series.ind1.setData(seriesData(m.line, times)); series.ind2.setData(seriesData(m.signal, times)); series.indH.setData(m.hist.map((v, i) => v == null ? { time: times[i] } : { time: times[i], value: v, color: v >= 0 ? up : dn })); view.ind = m; }
  else if (state.ind === 'atr') { const a = MSA.atr(bars, 14); series.ind1.setData(seriesData(a, times)); view.ind = { atr: a }; }
  else if (state.ind.startsWith('tv:') && tvd) {
    const key = state.ind.slice(3); const col = tvd.columns.find((c) => c.key === key); const name = col ? col.name : key;
    const findKey = (n) => tvd.columns.find((c) => c.name.toLowerCase() === n)?.key;
    series.ind1.setData(tvColumnSeries(tvd, key, times));
    const extra = {};
    if (/^macd$/i.test(name)) { const sk = findKey('signal'), hk = findKey('histogram'); if (sk) { series.ind2.setData(tvColumnSeries(tvd, sk, times)); extra.signal = sk; } if (hk) { series.indH.setData(tvColumnSeries(tvd, hk, times).map((p) => (p.value == null ? p : { ...p, color: p.value >= 0 ? up : dn }))); extra.hist = hk; } }
    if (/^rsi$/i.test(name)) { series.ipl.push(series.ind1.createPriceLine({ price: 70, color: css('--muted'), lineStyle: LW.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false }), series.ind1.createPriceLine({ price: 30, color: css('--muted'), lineStyle: LW.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false })); const mk = findKey('rsi-based ma'); if (mk) { series.ind2.setData(tvColumnSeries(tvd, mk, times)); extra.signal = mk; } }
    view.ind = { tvKey: key, tvName: name, ...extra };
  }
  const n = bars.length, show = state.tf === 'day' ? 260 : state.tf === 'week' ? 160 : 120;
  charts.price.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 5 });
  setLabels(n - 1);
}
function onCrosshair(c, p) {
  if (!view) return;
  if (!p.time) { Object.values(charts).forEach((o) => o !== c && o.clearCrosshairPosition()); setLabels(view.bars.length - 1); return; }
  const i = view.times.indexOf(p.time); if (i < 0) return;
  Object.values(charts).forEach((o) => { if (o !== c) { const s = o === charts.price ? series.candle : o === charts.vol ? series.vol : series.ind1; try { o.setCrosshairPosition(0, p.time, s); } catch {} } });
  setLabels(i);
}
function setLabels(i) {
  if (!view || i < 0) return; const b = view.bars[i]; if (!b) return;
  const chg = i > 0 ? (b.c / view.bars[i - 1].c - 1) * 100 : 0;
  const maTxt = view.maN.map((n, k) => (n && state.ma[k] ? `<span style="color:var(--ma${k === 0 ? (state.tf === 'day' ? 21 : 10) : k === 1 ? 50 : 200})">MA${n} ${fmt(view.ma[k][i])}</span>` : '')).filter(Boolean).join(' ');
  $('lPrice').innerHTML = `<b>${state.sym}</b> ${b.t} O ${fmt(b.o)} H ${fmt(b.h)} L ${fmt(b.l)} C <b class="${cls(chg)}">${fmt(b.c)}</b> (${fmtPct(chg)}) ${maTxt}${state.rs && view.rs[i] != null ? ` <span style="color:var(--rs)">RS ${fmt(view.rs[i] * 100, 1)}</span>` : ''}${state.bb && view.bb.up[i] != null ? ` BB ${fmt(view.bb.lo[i])}–${fmt(view.bb.up[i])}` : ''}`;
  $('lVol').innerHTML = `Vol <b>${fmtBig(b.v)}</b>${view.volMa[i] != null ? ` / avg ${fmtBig(view.volMa[i])} (${fmtPct((b.v / view.volMa[i] - 1) * 100, 0)})` : ''}`;
  const ind = view.ind || {};
  const tvv = (k) => { const v = view.tv?.rows && new Map(view.tv.rows.map((r) => [r.t, r.x[k]])).get(b.t); return typeof v === 'number' ? fmt(v, Math.abs(v) < 10 ? 3 : 2) : '—'; };
  if (view.tvOv?.length) $('lPrice').innerHTML += ' ' + view.tvOv.map((o) => `<span style="color:${o.color}">TV:${o.name} ${tvv(o.key)}</span>`).join(' ');
  $('lInd').innerHTML = state.ind.startsWith('tv:') && view.ind?.tvKey ? `TV: ${view.ind.tvName} <b>${tvv(view.ind.tvKey)}</b>${view.ind.signal ? ' / ' + tvv(view.ind.signal) : ''}${view.ind.hist ? ' / hist ' + tvv(view.ind.hist) : ''}` : state.ind === 'rsi' ? `RSI(14) <b>${fmt(ind.rsi?.[i])}</b>` : state.ind === 'macd' ? `MACD <b>${fmt(ind.line?.[i])}</b> Signal ${fmt(ind.signal?.[i])} Hist ${fmt(ind.hist?.[i])}` : state.ind === 'atr' ? `ATR(14) <b>${fmt(ind.atr?.[i])}</b>` : '';
}

// ---------- render: header / list / eval ----------
function renderHeader() {
  const d = state.data[state.sym] || {};
  const s = d.summary, q = d.quote || {}, st = d.stats?.statistics || {};
  $('hName').innerHTML = `${state.sym}<small>${q.name || ''} ${d.meta?.exchange ? '· ' + d.meta.exchange : ''}${d.tv ? ' · <span class="tag good" title="TradingViewデータ（ローカル）">TV ' + (settings.tvPriority ? '優先' : '参照') + ' 〜' + d.tv.to + '</span>' : ''}</small>`;
  if (!s) { $('hPx').textContent = d.err ? 'エラー' : '読込中…'; $('hKv').innerHTML = d.err ? `<span class="neg">${d.err}</span>` : ''; return; }
  $('hPx').innerHTML = `<span class="${cls(s.change)}">${fmt(s.close)}<small>${(s.change >= 0 ? '+' : '') + fmt(s.change)} (${fmtPct(s.changePct)})</small></span><div class="note">${s.date} 終値</div>`;
  const vm = st.valuations_metrics || {}, ss = st.stock_statistics || {};
  const fe = d.fundErr || {};
  const na = (k) => (fe[k] ? `<span title="${fe[k]}">N/A</span>` : '…');
  if (d.repo) {
    const pb = d.repo.sec?.peBand, dd = d.repo.drawdown, ins = d.repo.sec?.insiders;
    $('hKv').innerHTML = [
      ['High / Low', `<b>${fmt(s.high)} / ${fmt(s.low)}</b>`],
      ['52週 高 / 安', `<b>${fmt(s.hi52)} / ${fmt(s.lo52)}</b> <span class="${cls(s.fromHi52Pct)}">${fmtPct(s.fromHi52Pct)}</span>`],
      ['出来高', `<b>${fmtBig(s.volume)}</b> 50日比 <span class="${cls(s.volRatePct)}">${fmtPct(s.volRatePct, 0)}</span>`],
      ['TTM EPS (SEC)', `<b>${pb?.ttmEps != null ? fmt(pb.ttmEps) : '—'}</b> ${pb?.ttmEnd ? '<span class="note">〜' + pb.ttmEnd + '</span>' : ''}`],
      ['PER (実績)', `<b>${pb?.curPe != null ? fmt(pb.curPe, 1) : '—'}</b> ${pb?.percentile != null ? '<span class="note">5年分布の' + pb.percentile + '%点</span>' : ''}`],
      ['高値からの下落', `<b class="${cls(-(dd?.current?.depthPct || 0))}">${dd ? '-' + fmt(dd.current.depthPct, 1) + '%' : '—'}</b> ${dd ? '<span class="note">' + dd.current.days + '日</span>' : ''}`],
      ['インサイダー買い(12M)', `<b>${ins ? ins.buyCount + '件' : '—'}</b> ${ins?.lastBuy ? '<span class="note">最終 ' + ins.lastBuy + '</span>' : ''}`],
      ['次回決算', `<b>${d.next ? d.next.date : '—'}</b> ${d.next ? '<span class="note">' + d.next.time + '</span>' : ''}`],
    ].map(([k, v]) => `<span>${k}: ${v}</span>`).join('');
    return;
  }
  $('hKv').innerHTML = [
    ['High / Low', `<b>${fmt(s.high)} / ${fmt(s.low)}</b>`],
    ['52週 高 / 安', `<b>${fmt(s.hi52)} / ${fmt(s.lo52)}</b> <span class="${cls(s.fromHi52Pct)}">${fmtPct(s.fromHi52Pct)}</span>`],
    ['出来高', `<b>${fmtBig(s.volume)}</b> 50日比 <span class="${cls(s.volRatePct)}">${fmtPct(s.volRatePct, 0)}</span>`],
    ['時価総額', `<b>${settings.fund ? (d.stats ? fmtBig(vm.market_capitalization) : na('stats')) : '—'}</b>`],
    ['P/E · P/B', `<b>${settings.fund ? (d.stats ? fmt(vm.trailing_pe, 1) + ' · ' + fmt(vm.price_to_book_mrq, 1) : na('stats')) : '—'}</b>`],
    ['発行株数 / 浮動株', `<b>${settings.fund ? (d.stats ? fmtBig(ss.shares_outstanding) + ' / ' + fmtBig(ss.float_shares) : na('stats')) : '—'}</b>`],
    ['次回決算', `<b>${settings.fund ? (d.earnings ? (d.next ? d.next.date + (d.next.time ? ' ' + d.next.time : '') : '未定') : na('earnings')) : '—'}</b>`],
  ].map(([k, v]) => `<span>${k}: ${v}</span>`).join('');
}
function renderList() {
  const syms = settings.symbols.map((s) => s.toUpperCase());
  const rows = syms.map((s) => { const d = state.data[s] || {}; const sm = d.summary || {}; return { symbol: s, close: sm.close, changePct: sm.changePct, fromHi52Pct: sm.fromHi52Pct, volRatePct: sm.volRatePct, rs: d.rsPct, eps: d.eps?.latest, ad: d.ad ? d.ad.grade : null, adR: d.ad?.ratio, base: d.base?.status, baseLabel: d.base?.label, err: d.err }; });
  const { k, dir } = state.sort;
  const ord = { buyzone: 0, nearPivot: 1, rightSide: 2, forming: 3, extended: 4, none: 5 };
  rows.sort((a, b) => { let x = a[k], y = b[k]; if (k === 'base') { x = ord[x] ?? 9; y = ord[y] ?? 9; } if (k === 'ad') { x = a.adR; y = b.adR; } if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  const tb = $('wl').querySelector('tbody');
  tb.innerHTML = rows.map((r) => `<tr class="row ${r.symbol === state.sym ? 'sel' : ''}" data-s="${r.symbol}">
    <td class="sym">${r.symbol}${r.err ? ' <span class="neg" title="' + r.err + '">!</span>' : ''}</td><td>${fmt(r.close)}</td><td class="${cls(r.changePct)}">${fmtPct(r.changePct)}</td>
    <td class="${cls(r.fromHi52Pct)}">${fmtPct(r.fromHi52Pct, 1)}</td><td class="${cls(r.volRatePct)}">${fmtPct(r.volRatePct, 0)}</td>
    <td>${r.rs ?? '—'}</td><td class="${cls(r.eps)}">${r.eps == null ? '—' : fmtPct(r.eps, 0)}</td><td>${r.ad ? `<span class="grade ${r.ad}">${r.ad}</span>` : '—'}</td>
    <td title="${r.baseLabel || ''}">${baseTag(r.base)}</td></tr>`).join('');
  $('wlCount').textContent = `${syms.length}銘柄`;
  tb.querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => selectSymbol(tr.dataset.s)));
}
function baseTag(st) { const m = { buyzone: ['買いゾーン', 'good'], nearPivot: ['ピボット付近', 'good'], rightSide: ['右側形成', ''], forming: ['形成中', ''], extended: ['ゾーン超過', 'warn'], none: ['—', ''] }; const [t, c] = m[st] || ['…', '']; return `<span class="tag ${c}">${t}</span>`; }
function renderEval() {
  const d = state.data[state.sym]; const el = $('evalPane'); setTimeout(wireEval, 0);
  if (!d || !d.bars) { el.innerHTML = `<div class="sec note">${d?.err || '読込中…'}</div>`; return; }
  const b = d.base || {}, pv = b.status && b.status !== 'none' ? b : null, p = d.pivot || {};
  const adScore = { A: 90, B: 70, C: 50, D: 30, E: 10 }[d.ad?.grade] ?? null;
  const baseScore = { buyzone: 90, nearPivot: 75, rightSide: 55, forming: 40, extended: 35, none: 30 }[b.status] ?? 30;
  const parts = [[d.rsPct, 0.4], [d.epsPct, 0.3], [adScore, 0.15], [baseScore, 0.15]].filter((x) => x[0] != null);
  const wsum = parts.reduce((a, x) => a + x[1], 0); const comp = parts.length ? Math.round(parts.reduce((a, x) => a + x[0] * x[1], 0) / wsum) : null;
  const uni = Object.keys(state.data).filter((s) => state.data[s].bars && s !== settings.bench.toUpperCase()).length;
  const eg = d.eps;
  const fe = d.fundErr || {};
  el.innerHTML = `
  <div class="sec"><h4>総合スコア（本アプリ独自の近似）</h4><div class="score"><span class="big">${comp ?? '—'}</span><div class="bar"><i style="width:${comp ?? 0}%"></i></div></div>
    <div class="note">RS近似40% / EPS成長近似30% / A/D近似15% / ベース状況15%。母集団はウォッチリスト${uni}銘柄。O'Neil Score・Composite Ratingとは無関係。</div></div>
  <div class="sec"><h4>RS（相対強度）近似</h4><div class="kv2"><span>RSランク（リスト内百分位）</span><b>${d.rsPct ?? '—'} / 99</b><span>加重12か月騰落 raw</span><b>${d.rsRaw != null ? fmt((d.rsRaw - 1) * 100, 1) + '%' : '—'}</b>
    <span>対${settings.bench.toUpperCase()} 3か月</span><b>${relPerf(d, 63)}</b><span>対${settings.bench.toUpperCase()} 12か月</span><b>${relPerf(d, 252)}</b></div>
    <div class="note">直近63日の騰落率に2倍の重みを置く公開の近似式。IBDのRS Rating（全米市場母集団）とは母集団も式も異なります。</div></div>
  <div class="sec"><h4>EPS成長（近似）</h4>${settings.fund ? (eg && eg.quarters ? `<div class="kv2"><span>直近四半期 YoY</span><b class="${cls(eg.latest)}">${fmtPct(eg.latest, 0)}</b><span>直近3四半期平均</span><b class="${cls(eg.avg3)}">${fmtPct(eg.avg3, 0)}</b><span>リスト内ランク</span><b>${d.epsPct ?? '—'} / 99</b></div>
    <table class="eps"><tr><th>決算期</th><th>EPS</th><th>YoY</th></tr>${eg.yoy.map((y) => `<tr><td>${y.date}</td><td>${fmt(d.repo ? d.repo.sec?.qeps?.find((q) => q.end === y.date)?.eps : d.earnings?.earnings?.find((e) => e.date === y.date)?.eps_actual)}</td><td class="${cls(y.growthPct)}">${y.growthPct == null ? 'n/m' : fmtPct(y.growthPct, 0)}</td></tr>`).join('')}</table>
    <div class="note">出典: ${d.repo ? 'SEC EDGAR companyfacts（希薄化後EPS、Q4は年次−3四半期で導出）' : 'Twelve Data earnings（実績EPS）'}。前年同期がマイナスの場合は n/m。</div>` : `<div class="note">${fe.earnings ? 'earnings取得不可: ' + fe.earnings : '読込中…'}</div>`) : '<div class="note">設定でファンダメンタル取得を有効にしてください。</div>'}</div>
  <div class="sec"><h4>A/D（買い集め/売り抜け）近似</h4><div class="kv2"><span>50日 上昇日出来高 / 下落日出来高</span><b>${d.ad ? fmt(d.ad.ratio, 2) : '—'}</b><span>グレード</span><b>${d.ad ? `<span class="grade ${d.ad.grade}">${d.ad.grade}</span>` : '—'}</b></div>
    <div class="note">A≥1.5 · B≥1.2 · C≥0.9 · D≥0.7 · E&lt;0.7（本アプリの閾値）。</div></div>
  <div class="sec"><h4>ベース / ピボット（簡易検出）</h4>${pv ? `<div style="margin-bottom:6px">${baseTag(pv.status)} <span class="tag">${pv.shape}</span></div>
    <div class="kv2"><span>状況</span><b>${pv.label}</b><span>ピボット（左側高値）</span><b>${fmt(pv.pivot)} <span class="note">${pv.leftDate}</span></b><span>買いゾーン</span><b>${fmt(pv.pivot)} – ${fmt(pv.zoneTop)}</b><span>ピボットまで</span><b class="${cls(pv.toPivotPct)}">${fmtPct(pv.toPivotPct, 1)}</b>
    <span>深さ</span><b>${fmt(pv.depthPct, 1)}% <span class="note">安値 ${fmt(pv.low)} ${pv.lowDate}</span></b><span>期間</span><b>${pv.weeks}週</b><span>損切り目安（-7%/-8%）</span><b>${fmt(pv.pivot * 0.93)} / ${fmt(pv.pivot * 0.92)}</b></div>` :
    `<div class="note">${b.reason || '—'}</div><div class="kv2" style="margin-top:6px"><span>直近60日高値（代替ピボット）</span><b>${fmt(p.pivot)}</b><span>ピボットまで</span><b class="${cls(p.toPivotPct)}">${fmtPct(p.toPivotPct, 1)}</b></div>`}
    <div class="note">週足で「左側高値→8〜50%の押し→7週以上」を満たす直近のパターンを機械的に抽出。IBD Pattern Recognitionの代替ではありません。</div></div>
  ${bottomSection(d)}${baseRateSection(d)}${tvSection(d)}${d.repo ? repoSections(d) : `<div class="sec note">データ: Twelve Data / 取得 ${new Date(LS.get(cacheKey('ts', state.sym), {}).at || 0).toLocaleString('ja-JP')}${fe.stats || fe.quote ? '<br>ファンダ取得不可: ' + [fe.quote, fe.stats].filter(Boolean).join(' / ') : ''}</div>`}`;
}


function bottomLevels(d) {
  const L = []; const s = d.summary; if (!s) return L;
  const pb = d.repo?.sec?.peBand, dd = d.repo?.drawdown, ins = d.repo?.sec?.insiders;
  if (pb?.band) { L.push({ src: 'PER 10%点 × TTM EPS', price: pb.band.p10, kind: 'val' }); L.push({ src: 'PER 25%点 × TTM EPS', price: pb.band.p25, kind: 'val' }); }
  if (dd && dd.count) { const pk = dd.current.peak; if (dd.median) L.push({ src: `過去下落の中央値 -${dd.median}%（高値${fmt(pk)}基準）`, price: pk * (1 - dd.median / 100), kind: 'dd' }); if (dd.p75) L.push({ src: `過去下落の75%点 -${dd.p75}%`, price: pk * (1 - dd.p75 / 100), kind: 'dd' }); if (dd.max) L.push({ src: `過去最大下落 -${dd.max}%`, price: pk * (1 - dd.max / 100), kind: 'dd' }); }
  const closes = d.bars.map((b) => b.c); const m200 = MSA.sma(closes, 200).at(-1), m50 = MSA.sma(closes, 50).at(-1);
  if (m200) L.push({ src: '200日移動平均', price: m200, kind: 'ta' }); if (m50) L.push({ src: '50日移動平均', price: m50, kind: 'ta' });
  if (d.base && d.base.status !== 'none') L.push({ src: `直近ベース安値（${d.base.lowDate}）`, price: d.base.low, kind: 'ta' });
  L.push({ src: '52週安値', price: s.lo52, kind: 'ta' });
  if (ins?.buyers?.length) { const sh = ins.buyers.reduce((a, b) => a + b.shares, 0), val = ins.buyers.reduce((a, b) => a + b.value, 0); if (sh > 0) L.push({ src: `インサイダー買付の平均単価（${ins.buyCount}件）`, price: val / sh, kind: 'ins' }); }
  const wk = d.weekly || []; if (wk.length > 30) { const lows = wk.slice(-52).map((w) => w.l).sort((a, b) => a - b); L.push({ src: '52週内の週足安値 25%点（下ヒゲ帯）', price: lows[Math.floor(lows.length * 0.25)], kind: 'ta' }); }
  const out = [];
  for (const l of L.map((x) => ({ ...x, price: +(+x.price).toFixed(2) })).filter((x) => isFinite(x.price) && x.price > 0)) { const same = out.find((o) => o.kind === l.kind && Math.abs(o.price / l.price - 1) < 0.001); if (same) same.src += ' ＝ ' + l.src; else out.push(l); }
  return out;
}
function bottomSection(d) {
  const px = d.summary?.close; if (!px) return '';
  const lv = bottomLevels(d); const bz = MSB.bottomZone(lv, px, 0.03); d.bz = bz;
  const kindTag = { val: 'バリュエーション', dd: '過去下落幅', ta: 'テクニカル', ins: 'インサイダー' };
  let h = `<div class="sec"><h4>底値 参考ゾーン（予測ではなく、過去の物差しの集まり）</h4>`;
  if (!bz.levels.length) h += '<div class="note">現値より下の参照水準がありません（データ不足または全水準が現値以上）。</div>';
  else {
    if (bz.thick.length) h += `<div style="margin-bottom:6px">${bz.thick.slice(0, 3).map((c) => `<span class="tag good">${fmt(c.low)}–${fmt(c.high)}（${fmtPct(c.fromPricePct, 0)}、根拠${c.count}件）</span>`).join(' ')}</div>`;
    else h += '<div class="note" style="margin-bottom:6px">±3%以内に2件以上重なる価格帯はありません（根拠が分散）。</div>';
    h += `<table class="eps"><tr><th>水準</th><th>現値比</th><th>根拠</th></tr>${bz.levels.map((l) => `<tr><td>${fmt(l.price)}</td><td class="neg">${fmtPct((l.price / px - 1) * 100, 1)}</td><td style="text-align:left;font-family:var(--font)">${l.src} <span class="note">${kindTag[l.kind]}</span></td></tr>`).join('')}</table>`;
    if (bz.above.length) h += `<div class="note">現値以上のため除外: ${bz.above.map((l) => l.src.split('（')[0] + ' ' + fmt(l.price)).join(' / ')}</div>`;
  }
  h += `<div class="note">「ここで止まる」という予測ではありません。将来EPSの変化、市場全体の下落、個別ニュースは考慮していません。チャートの「底値帯」で重なり帯を表示できます。</div></div>`;
  return h;
}
function baseRateSection(d) {
  if (!d.feats) return `<div class="sec"><h4>急騰の過去発生率</h4><div class="note">日足が220本未満のため計算できません。</div></div>`;
  const pool = Object.keys(state.data).filter((s) => s !== state.sym && s !== settings.bench.toUpperCase() && state.data[s].feats).map((s) => ({ sym: s, feats: state.data[s].feats }));
  const br = MSB.baseRate(d.feats, pool, state.brWidth); d.br = br;
  let h = `<div class="sec"><h4>急騰の過去発生率（今と似た状態の後にどうなったか）</h4>`;
  if (!br.ok) return h + `<div class="note">${br.reason}</div></div>`;
  h += `<div class="note">現在の状態: ${br.cur.map((c) => `${c.label} <b>${c.text}</b>`).join(' · ')}</div>
  <div class="note" style="margin:4px 0">類似の幅 <input type="range" id="brWidth" min="0.5" max="2.5" step="0.25" value="${state.brWidth}" style="width:120px;vertical-align:middle"> ×${state.brWidth}（各指標の許容差: ${br.cur.map((c) => '±' + (c.k === 'vol' ? c.tol.toFixed(2) : c.tol.toFixed(0))).join(', ')}）</div>`;
  const row = (label, st, unc) => st.n ? `<tr><td style="text-align:left;font-family:var(--font)">${label}</td><td>${st.n}</td><td class="${st.n < 30 ? 'neg' : ''}">${fmt(st.hit10, 0)}%${unc ? ` <span class="note">(${fmt(unc.hit10, 0)})</span>` : ''}</td><td>${fmt(st.hit20, 0)}%${unc ? ` <span class="note">(${fmt(unc.hit20, 0)})</span>` : ''}</td><td class="${cls(st.med)}">${fmtPct(st.med, 1)}</td><td>${fmtPct(st.p25, 0)} 〜 ${fmtPct(st.p75, 0)}</td><td class="neg">${fmtPct(st.min, 0)}</td></tr>` : `<tr><td style="text-align:left;font-family:var(--font)">${label}</td><td>0</td><td colspan="5" class="note">該当なし</td></tr>`;
  h += `<table class="eps"><tr><th>母集団 / 期間</th><th>n</th><th>+10%到達</th><th>+20%到達</th><th>中央値</th><th>25〜75%</th><th>最悪</th></tr>
    ${row(`${state.sym} 単独 / 20日`, br.own.h20, br.unconditional[20])}${row(`${state.sym} 単独 / 60日`, br.own.h60, br.unconditional[60])}
    ${row(`リスト${br.pool.symbols}銘柄プール / 20日`, br.pool.h20)}${row(`リスト${br.pool.symbols}銘柄プール / 60日`, br.pool.h60)}</table>
  <div class="note">「到達」= 期間内の終値の最大値が +10%/+20% 以上。括弧内は条件を付けない同銘柄の全期間ベース。n は重複する連続日を1エピソードに集約した件数で、<b>30未満は参考になりません</b>（赤字）。</div>`;
  if (br.own.recent.length) h += `<details><summary class="note">直近の類似エピソード（${state.sym}）</summary><table class="eps"><tr><th>日付</th><th>20日後</th><th>20日内最大</th><th>60日後</th><th>60日内最大</th></tr>${br.own.recent.map((e) => `<tr><td>${e.t}</td><td class="${cls(e.ret20)}">${e.ret20 == null ? '—' : fmtPct(e.ret20, 1)}</td><td>${e.max20 == null ? '—' : fmtPct(e.max20, 1)}</td><td class="${cls(e.ret60)}">${e.ret60 == null ? '—' : fmtPct(e.ret60, 1)}</td><td>${e.max60 == null ? '—' : fmtPct(e.max60, 1)}</td></tr>`).join('')}</table></details>`;
  const wf = MSB.walkForward(d.feats, state.brWidth, 20, 10); d.wf = wf;
  h += `<div style="margin-top:6px"><b class="note">後出し検証（ウォークフォワード、${state.sym}単独・20日+10%）</b><div class="kv2">`;
  if (wf.note) h += `<span class="note">${wf.note}</span><b>n=${wf.n}</b>`;
  else h += `<span>検証点 / 無条件の到達率</span><b>${wf.n} / ${fmt(wf.baseRate, 0)}%</b><span>「到達率50%以上」と出た局面の実際の到達率</span><b>${wf.hiRealized != null ? fmt(wf.hiRealized, 0) + '%（n=' + wf.hiN + '）' : '—'}</b><span>「50%未満」と出た局面の実際の到達率</span><b>${wf.loRealized != null ? fmt(wf.loRealized, 0) + '%（n=' + wf.loN + '）' : '—'}</b><span>Brierスキル（無条件比）</span><b class="${cls(wf.skill)}">${wf.skill != null ? fmtPct(wf.skill, 0) : '—'}</b>`;
  h += `</div><div class="note">各過去時点で「それ以前のデータだけ」で同じ計算をした結果と実際を比較。スキルが0%以下なら、この条件付けは無条件ベースより当たっていません。</div></div></div>`;
  return h;
}
function tvSection(d) {
  const t = d.tv; if (!t) return '';
  const est = Object.entries(t.estHistory || {});
  const last = t.rows[t.rows.length - 1]; const px = d.summary?.close || last.c;
  const val = (name) => { const c = t.columns.find((x) => x.name === name); return c ? last.x[c.key] : null; };
  const epsFY = val('EPS Estimate FY'), epsFQ = val('EPS Estimate FQ'), revFY = val('Revenue Estimate FY'), revFQ = val('Revenue Estimate FQ');
  const ttm = d.repo?.sec?.peBand?.ttmEps ?? null;
  const snaps = state.tv.snapshots.filter((x) => x.symbol === state.sym); const rev = TV.revisions(snaps);
  let h = `<div class="sec"><h4>TradingView取込（ローカル保存・${t.tf}・〜${t.to}）</h4>`;
  if (epsFY != null || epsFQ != null) {
    h += `<div class="kv2"><span>EPS予想 FQ / FY</span><b>${fmt(epsFQ, 3)} / ${fmt(epsFY, 3)}</b><span>売上予想 FQ / FY</span><b>${fmtBig(revFQ)} / ${fmtBig(revFY)}</b>
      <span>予想PER（株価÷FY予想EPS）</span><b>${epsFY > 0 ? fmt(px / epsFY, 1) + 'x' : '—'}</b>${ttm != null && epsFY != null ? `<span>FY予想EPS ÷ SEC実績TTM</span><b class="${cls(epsFY / ttm - 1)}">${fmtPct((epsFY / ttm - 1) * 100, 0)}</b>` : ''}</div>
      <div class="note">値はCSV最終行（${last.t}）時点。四半期境界でしか変化しない列のため、日々の修正は取り込みのたびに下のスナップショットで追跡します。</div>`;
  }
  if (rev.length) h += `<table class="eps"><tr><th>取込</th><th>基準日</th>${Object.keys(rev[0].values).map((k) => `<th>${k.replace(/ Estimate/i, '')}</th>`).join('')}</tr>${rev.slice(0, 6).map((r) => `<tr><td>${r.uploadedAt.slice(0, 10)}</td><td>${r.asOf}</td>${Object.keys(rev[0].values).map((k) => `<td>${Math.abs(r.values[k]) > 1e6 ? fmtBig(r.values[k]) : fmt(r.values[k], 3)}${r.deltaPct[k] != null ? `<br><span class="${cls(r.deltaPct[k])}">${fmtPct(r.deltaPct[k], 1)}</span>` : ''}</td>`).join('')}</tr>`).join('')}</table><div class="note">前回取込比の変化＝コンセンサス修正の方向（本アプリの記録に基づく）。</div>`;
  const eh = est.find(([k]) => /EPS Estimate FQ/i.test(k));
  if (eh) h += `<details><summary class="note">四半期別 EPS予想の推移（CSV内の段階値 ${eh[1].length}期）</summary><table class="eps"><tr><th>期間</th><th>EPS予想FQ</th><th>前期比</th></tr>${eh[1].slice().reverse().slice(0, 8).map((p, i, arr) => { const prev = arr[i + 1]; return `<tr><td>${p.from}〜${p.to}</td><td>${fmt(p.value, 3)}</td><td class="${prev ? cls(p.value / prev.value - 1) : ''}">${prev ? fmtPct((p.value / prev.value - 1) * 100, 0) : '—'}</td></tr>`; }).join('')}</table></details>`;
  h += `<div class="note">株価: ${settings.tvPriority ? 'TradingViewの値で上書き（重複日）' : '参照のみ（上書きなし）'}。列: ${t.columns.map((c) => c.name).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</div></div>`;
  return h;
}
function repoSections(d) {
  const r = d.repo, sec = r.sec || {}, pb = sec.peBand, dd = r.drawdown, er = sec.earnings, ins = sec.insiders, px = d.summary.close;
  const secLink = sec.cik ? `<a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${sec.cik}&type=&dateb=&owner=include&count=40" target="_blank" rel="noopener">EDGAR</a>` : '';
  let h = '';
  // valuation band
  h += `<div class="sec"><h4>バリュエーション帯（SEC実績EPS × 過去${pb?.years || 5}年PER分布）</h4>`;
  if (sec.skipped) h += '<div class="note">ETF等のためSECデータ対象外。</div>';
  else if (!pb) h += `<div class="note">算出不可（EPSデータなし${sec.errors?.length ? ': ' + sec.errors.join(' / ') : ''}）</div>`;
  else if (pb.note) h += `<div class="note">${pb.note}（TTM EPS ${fmt(pb.ttmEps)}）</div>`;
  else {
    const rows = [['p10', '10%点'], ['p25', '25%点'], ['p50', '中央値'], ['p75', '75%点'], ['p90', '90%点']];
    h += `<div class="kv2"><span>現在PER / 分布内順位</span><b>${fmt(pb.curPe, 1)}x / ${pb.percentile}%点</b><span>TTM EPS（〜${pb.ttmEnd}）</span><b>${fmt(pb.ttmEps)}</b></div>
    <table class="eps"><tr><th>分位</th><th>PER</th><th>株価帯</th><th>現値比</th></tr>${rows.map(([k, l]) => `<tr><td>${l}</td><td>${fmt(pb.pe[k], 1)}x</td><td>${fmt(pb.band[k])}</td><td class="${cls(pb.band[k] / px - 1)}">${fmtPct((pb.band[k] / px - 1) * 100, 0)}</td></tr>`).join('')}</table>
    <div class="note">株価帯 = 現在のTTM EPS × 過去PERの分位（有効${pb.samples}営業日${pb.windowDays && pb.windowDays !== pb.samples ? ' / 対象' + pb.windowDays : ''}）。EPSは初回開示日以降にのみ反映（先読みなし）、株式分割は現在の株数基準に調整済み${(r.splits || []).length ? '（' + r.splits.map((x) => x.date + ' ' + fmt(x.ratio, 0) + ':1').join(', ') + '）' : ''}。${pb.caveat ? '<br><b>' + pb.caveat + '</b>：赤字・大幅減益の時期はPERが発散して上位分位を歪めるため、分布から外しています。' : ''}将来EPSは考慮しない参考ゾーンです。</div>`;
  }
  h += '</div>';
  // drawdown
  if (dd) h += `<div class="sec"><h4>下落の深さ（過去の下落局面との比較）</h4><div class="kv2"><span>直近高値 ${dd.current.peakDate}</span><b>${fmt(dd.current.peak)}</b><span>現在の下落率</span><b class="neg">-${fmt(dd.current.depthPct, 1)}%</b><span>この局面の最大下落</span><b class="neg">-${fmt(dd.current.maxDepthPct, 1)}% <span class="note">${dd.current.troughDate}</span></b><span>過去局面の中央値 / 75% / 最大</span><b>${dd.median != null ? '-' + fmt(dd.median, 1) + '% / -' + fmt(dd.p75, 1) + '% / -' + fmt(dd.max, 1) + '%' : '—'}</b></div><div class="note">${dd.rankNote}（対象: 保持している日足${d.bars.length}本、10%以上の下落）</div>
    ${dd.episodes.length ? `<table class="eps"><tr><th>高値日</th><th>安値日</th><th>深さ</th><th>回復日</th></tr>${dd.episodes.slice().reverse().slice(0, 6).map((e) => `<tr><td>${e.peakDate}</td><td>${e.troughDate}</td><td class="neg">-${fmt(e.depthPct, 1)}%</td><td>${e.recoverDate}</td></tr>`).join('')}</table>` : ''}</div>`;
  // earnings events
  if (er) {
    const evs = er.events.filter((e) => !e.pending);
    h += `<div class="sec"><h4>決算イベント（8-K Item 2.02 提出日ベース）</h4><div class="kv2"><span>過去${er.n}回の平均変動幅（絶対値）</span><b>${er.avgAbsMove != null ? fmt(er.avgAbsMove) + '%' : '—'}</b><span>上昇 / 下落</span><b>${er.upCount} / ${er.n - er.upCount}</b></div>
    ${evs.length ? `<table class="eps"><tr><th>発表日</th><th>反応日</th><th>ギャップ</th><th>終値</th><th>5日後</th></tr>${evs.slice(0, 8).map((e) => `<tr><td>${e.filingDate}${e.afterClose ? '<span class="note"> AH</span>' : ''}</td><td>${e.tradeDate}</td><td class="${cls(e.gapPct)}">${fmtPct(e.gapPct, 1)}</td><td class="${cls(e.reactionPct)}">${fmtPct(e.reactionPct, 1)}</td><td class="${cls(e.reaction5dPct)}">${e.reaction5dPct == null ? '—' : fmtPct(e.reaction5dPct, 1)}</td></tr>`).join('')}</table>` : '<div class="note">該当する8-Kなし</div>'}
    <div class="note">AH=引け後提出→翌営業日を反応日。終値=反応日終値の前日比、5日後=反応日を1日目とした5営業日目。次回決算日はSECからは取得できないため「前回+91日」の推定です。</div></div>`;
  }
  // insiders
  if (ins) h += `<div class="sec"><h4>インサイダー売買（Form 4、直近${settings.insiderMonths || 12}か月）</h4><div class="kv2"><span>市場買付（コードP）</span><b class="${ins.buyCount ? 'pos' : ''}">${ins.buyCount}件 / $${fmtBig(ins.buyValue)}</b><span>売却（コードS）</span><b>${ins.sellCount}件 / $${fmtBig(ins.sellValue)}</b><span>解析済み / 対象提出</span><b>${ins.parsed} / ${ins.filingsInWindow}${ins.pending ? ' <span class="note">(未取得' + ins.pending + ')</span>' : ''}</b></div>
    ${ins.buyers.length ? `<table class="eps"><tr><th>買い手</th><th>件</th><th>株数</th><th>金額</th><th>最終</th></tr>${ins.buyers.slice(0, 6).map((b) => `<tr><td title="${b.role}">${b.who}<br><span class="note">${b.role}</span></td><td>${b.n}</td><td>${fmtBig(b.shares)}</td><td>$${fmtBig(b.value)}</td><td>${b.last}</td></tr>`).join('')}</table>` : '<div class="note">期間内の市場買付なし</div>'}
    <div class="note">売却には報酬株式の売却・自動売却(10b5-1)を含むため、買付のみを主指標にしています。${secLink}</div></div>`;
  h += `<div class="sec note">データ更新 ${new Date(r.updatedAt).toLocaleString('ja-JP')} · 株価: ${r.priceSource || '—'}${r.errors?.length ? '<br><span class="neg">エラー: ' + r.errors.join(' / ') + '</span>' : ''}</div>`;
  return h;
}
function relPerf(d, n) {
  if (!state.bench || !d.bars || d.bars.length <= n) return '—';
  const bm = new Map(state.bench.map((b) => [b.t, b.c]));
  const a = d.bars[d.bars.length - 1], b0 = d.bars[d.bars.length - 1 - n];
  const ba = bm.get(a.t), bb = bm.get(b0.t); if (!ba || !bb) return '—';
  const rel = ((a.c / b0.c) / (ba / bb) - 1) * 100;
  return `<span class="${cls(rel)}">${fmtPct(rel, 1)}</span>`;
}
function wireEval() { const r = $('brWidth'); if (r) r.addEventListener('change', (e) => { state.brWidth = +e.target.value; LS.set('msc:brWidth', state.brWidth); renderEval(); }); }
function renderAll() { renderTvControls(); renderHeader(); renderChart(); renderEval(); renderList(); }

// ---------- data table ----------
function toggleTable() {
  const el = $('dataTbl'); if (el.classList.contains('show')) { el.classList.remove('show'); return; }
  if (!view) return; const rows = view.bars.slice(-60).reverse();
  el.innerHTML = `<table><tr><th>日付</th><th>始値</th><th>高値</th><th>安値</th><th>終値</th><th>出来高</th><th>MA${view.maN[0]}</th><th>MA${view.maN[1]}</th>${view.maN[2] ? `<th>MA${view.maN[2]}</th>` : ''}<th>RS</th></tr>${rows.map((b) => { const i = view.bars.indexOf(b); return `<tr><td>${b.t}</td><td>${fmt(b.o)}</td><td>${fmt(b.h)}</td><td>${fmt(b.l)}</td><td>${fmt(b.c)}</td><td>${fmtBig(b.v)}</td><td>${fmt(view.ma[0][i])}</td><td>${fmt(view.ma[1][i])}</td>${view.maN[2] ? `<td>${fmt(view.ma[2][i])}</td>` : ''}<td>${view.rs[i] != null ? fmt(view.rs[i] * 100, 1) : '—'}</td></tr>`; }).join('')}</table>`;
  el.classList.add('show');
}

// ---------- settings ----------
function openSettings() {
  $('sSrc').value = settings.source || 'auto'; $('sApi').value = settings.apiKey; $('sSyms').value = settings.symbols.join(', '); $('sBench').value = settings.bench; $('sOut').value = String(settings.outputsize); $('sFund').checked = !!settings.fund; $('sTtl').value = settings.ttlHours;
  $('modal').classList.add('show');
}
function saveSettings() {
  const syms = $('sSyms').value.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  settings = { source: $('sSrc').value, apiKey: $('sApi').value.trim(), symbols: syms.length ? syms : DEFAULTS.symbols, bench: ($('sBench').value.trim() || 'SPY').toUpperCase(), outputsize: +$('sOut').value || 1000, fund: $('sFund').checked, ttlHours: +$('sTtl').value || 12 };
  LS.set('msc:settings', settings); $('modal').classList.remove('show');
  state.data = {}; state.bench = null;
  if (!settings.symbols.includes((state.sym || '').toUpperCase())) state.sym = settings.symbols[0];
  boot(false);
}
function clearCache() { LS.keys().filter((k) => /^msc:(ts|quote|stats|earn):/.test(k)).forEach((k) => LS.del(k)); state.data = {}; state.bench = null; updateStatus('キャッシュを消去しました'); }

// ---------- wiring ----------
function wire() {
  $('btnGo').onclick = () => selectSymbol($('symInput').value);
  $('symInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') selectSymbol($('symInput').value); });
  $('btnAdd').onclick = () => { const s = ($('symInput').value || state.sym || '').trim().toUpperCase(); if (!s) return; if (!settings.symbols.includes(s)) { settings.symbols.push(s); LS.set('msc:settings', settings); } selectSymbol(s); };
  $('btnRefresh').onclick = () => boot(true);
  $('btnTv').onclick = () => { renderTvModal(); $('tvModal').classList.add('show'); };
  $('tvClose').onclick = () => $('tvModal').classList.remove('show');
  $('tvFile').addEventListener('change', (e) => tvHandleFiles([...e.target.files]));
  const dz = $('tvDrop'); dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); }); dz.addEventListener('dragleave', () => dz.classList.remove('over')); dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); tvHandleFiles([...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name))); });
  $('tvPriority').addEventListener('change', (e) => { settings.tvPriority = e.target.checked; LS.set('msc:settings', settings); for (const s of Object.keys(state.data)) { applyTv(s); analyze(s); } universeRanks(); renderList(); renderAll(); });
  $('btnSettings').onclick = openSettings; $('sCancel').onclick = () => $('modal').classList.remove('show'); $('sSave').onclick = saveSettings; $('sClear').onclick = clearCache;
  $('tfGrp').querySelectorAll('button').forEach((b) => (b.onclick = () => { state.tf = b.dataset.tf; $('tfGrp').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); $('swMa1').querySelector('span').textContent = state.tf === 'day' ? '21' : '10'; $('swMa2').querySelector('span').textContent = state.tf === 'day' ? '50' : '40'; $('swMa3').style.display = state.tf === 'day' ? '' : 'none'; renderChart(); }));
  $('btnLog').onclick = () => { state.log = !state.log; $('btnLog').classList.toggle('on', state.log); renderChart(); };
  [['swMa1', (v) => (state.ma[0] = v)], ['swMa2', (v) => (state.ma[1] = v)], ['swMa3', (v) => (state.ma[2] = v)], ['swRs', (v) => (state.rs = v)], ['swBb', (v) => (state.bb = v)], ['swZone', (v) => (state.zone = v)], ['swPeb', (v) => (state.peb = v)], ['swBz', (v) => (state.bz = v)]].forEach(([id, f]) => $(id).querySelector('input').addEventListener('change', (e) => { f(e.target.checked); renderChart(); }));
  $('indSel').onchange = (e) => { state.ind = e.target.value; renderChart(); };
  $('btnTbl').onclick = toggleTable; $('btnFit').onclick = () => Object.values(charts).forEach((c) => c.timeScale().fitContent());
  $('btnTheme').onclick = () => { const r = document.documentElement; const cur = r.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); r.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark'); LS.set('msc:theme', r.getAttribute('data-theme')); buildCharts(); renderChart(); };
  $('wl').querySelectorAll('th').forEach((th) => (th.onclick = () => { const k = th.dataset.k; state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : 1 }; renderList(); }));
  window.addEventListener('resize', () => setTimeout(() => Object.values(charts).forEach((c) => c.timeScale().applyOptions({})), 50));
}
(function init() {
  const th = LS.get('msc:theme', null); if (th) document.documentElement.setAttribute('data-theme', th);
  wire(); buildCharts(); renderList(); updateStatus();
  if (location.protocol === 'file:') $('footData').textContent += ' · ローカルファイルで実行中（キーはlocalStorageに保存）';
  boot(false);
})();
