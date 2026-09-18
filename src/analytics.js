// ===== MarketSmith-style analytics (pure functions, no DOM) =====
// Bars: ascending array of {t:'YYYY-MM-DD', o,h,l,c,v}
const MSA = (() => {
  // --- parsing ---
  function parseTwelveData(values) {
    const out = [];
    for (const r of values || []) {
      const o = +r.open, h = +r.high, l = +r.low, c = +r.close, v = +r.volume || 0;
      if (!isFinite(c)) continue;
      out.push({ t: String(r.datetime).slice(0, 10), o, h, l, c, v });
    }
    out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    // dedupe
    return out.filter((b, i) => i === 0 || b.t !== out[i - 1].t);
  }

  // --- aggregation ---
  function weekKey(t) {
    const d = new Date(t + 'T00:00:00Z');
    const day = d.getUTCDay(); // 0 Sun..6 Sat
    const diff = (day + 6) % 7; // days since Monday
    d.setUTCDate(d.getUTCDate() - diff);
    return d.toISOString().slice(0, 10);
  }
  function aggregate(bars, unit) {
    if (unit === 'day') return bars;
    const keyFn = unit === 'week' ? weekKey : (t) => t.slice(0, 7) + '-01';
    const out = [];
    let cur = null, key = null;
    for (const b of bars) {
      const k = keyFn(b.t);
      if (k !== key) {
        if (cur) out.push(cur);
        cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        key = k;
      } else {
        cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.t = b.t;
      }
    }
    if (cur) out.push(cur);
    return out; // t = last trading day of the period
  }

  // --- indicators (return arrays aligned to input; null when undefined) ---
  function sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function ema(arr, n) {
    const out = new Array(arr.length).fill(null);
    const k = 2 / (n + 1);
    let prev = null, seed = 0;
    for (let i = 0; i < arr.length; i++) {
      if (i < n - 1) { seed += arr[i]; continue; }
      if (i === n - 1) { seed += arr[i]; prev = seed / n; out[i] = prev; continue; }
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    let ag = 0, al = 0;
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= n) { ag += g; al += l; if (i === n) { ag /= n; al /= n; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } continue; }
      ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n;
      out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    }
    return out;
  }
  function macd(closes, f = 12, s = 26, sig = 9) {
    const ef = ema(closes, f), es = ema(closes, s);
    const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const valid = line.map((x) => (x == null ? 0 : x));
    const firstIdx = line.findIndex((x) => x != null);
    const sigArr = new Array(closes.length).fill(null);
    if (firstIdx >= 0) {
      const e = ema(valid.slice(firstIdx), sig);
      for (let i = 0; i < e.length; i++) sigArr[firstIdx + i] = e[i];
    }
    const hist = line.map((x, i) => (x != null && sigArr[i] != null ? x - sigArr[i] : null));
    return { line, signal: sigArr, hist };
  }
  function bollinger(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const up = new Array(closes.length).fill(null), lo = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; lo[i] = mid[i] - k * sd;
    }
    return { mid, up, lo };
  }
  function atr(bars, n = 14) {
    const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
    const out = new Array(bars.length).fill(null);
    let prev = null;
    for (let i = 0; i < tr.length; i++) {
      if (i < n - 1) continue;
      if (i === n - 1) { prev = tr.slice(0, n).reduce((a, b) => a + b, 0) / n; out[i] = prev; continue; }
      prev = (prev * (n - 1) + tr[i]) / n; out[i] = prev;
    }
    return out;
  }

  // --- relative strength line (price / benchmark, aligned by date) ---
  function rsLine(bars, bench) {
    const bm = new Map(bench.map((b) => [b.t, b.c]));
    const out = [];
    let last = null;
    for (const b of bars) {
      const bc = bm.get(b.t) ?? last;
      if (bc == null) { out.push(null); continue; }
      last = bc;
      out.push(b.c / bc);
    }
    return out;
  }

  // --- summary stats ---
  function pctChange(a, b) { return b ? (a / b - 1) * 100 : null; }
  function summary(bars) {
    const n = bars.length;
    if (!n) return null;
    const last = bars[n - 1], prev = bars[n - 2] || last;
    const w = bars.slice(Math.max(0, n - 252));
    const hi52 = Math.max(...w.map((b) => b.h)), lo52 = Math.min(...w.map((b) => b.l));
    const vol50 = n > 51 ? bars.slice(n - 51, n - 1).reduce((a, b) => a + b.v, 0) / 50 : null;
    return {
      close: last.c, date: last.t, change: last.c - prev.c, changePct: pctChange(last.c, prev.c),
      high: last.h, low: last.l, volume: last.v,
      hi52, lo52, fromHi52Pct: pctChange(last.c, hi52), fromLo52Pct: pctChange(last.c, lo52),
      avgVol50: vol50, volRatePct: vol50 ? (last.v / vol50 - 1) * 100 : null,
    };
  }

  // --- IBD-style RS strength raw score (NOT IBD's formula; public approximation) ---
  // 40% weight on last 63 trading days, 20% each on the 3 prior quarters.
  function rsRaw(bars) {
    const n = bars.length;
    if (n < 253) { // degrade gracefully with available history
      if (n < 64) return null;
      const c = bars[n - 1].c;
      const q1 = c / bars[n - 64].c, q2 = n > 127 ? c / bars[n - 127].c : q1, q3 = n > 190 ? c / bars[n - 190].c : q2;
      return 0.4 * q1 + 0.2 * q2 + 0.2 * q3 + 0.2 * q3;
    }
    const c = bars[n - 1].c;
    return 0.4 * (c / bars[n - 64].c) + 0.2 * (c / bars[n - 127].c) + 0.2 * (c / bars[n - 190].c) + 0.2 * (c / bars[n - 253].c);
  }
  // percentile rank 1..99 within a universe of raw values
  function percentile(value, universe) {
    const u = universe.filter((x) => x != null);
    if (value == null || u.length < 2) return null;
    const below = u.filter((x) => x < value).length;
    const eq = u.filter((x) => x === value).length;
    const p = (below + 0.5 * eq) / u.length;
    return Math.max(1, Math.min(99, Math.round(p * 98 + 1)));
  }

  // --- Accumulation/Distribution approximation: 50-day up/down volume ratio ---
  function adRating(bars, n = 50) {
    const s = bars.slice(-n - 1);
    if (s.length < 21) return null;
    let up = 0, dn = 0;
    for (let i = 1; i < s.length; i++) {
      if (s[i].c > s[i - 1].c) up += s[i].v; else if (s[i].c < s[i - 1].c) dn += s[i].v;
    }
    const ratio = dn === 0 ? 9 : up / dn;
    const grade = ratio >= 1.5 ? 'A' : ratio >= 1.2 ? 'B' : ratio >= 0.9 ? 'C' : ratio >= 0.7 ? 'D' : 'E';
    return { ratio, grade };
  }

  // --- EPS growth from Twelve Data earnings list (newest first) ---
  function epsGrowth(earnings) {
    const rows = (earnings || []).filter((e) => e.eps_actual != null).map((e) => ({ date: e.date, eps: +e.eps_actual }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    const yoy = [];
    for (let i = 0; i < rows.length - 4 && yoy.length < 4; i++) {
      const cur = rows[i].eps, prior = rows[i + 4].eps;
      if (prior > 0) yoy.push({ date: rows[i].date, growthPct: (cur / prior - 1) * 100 });
      else yoy.push({ date: rows[i].date, growthPct: null }); // negative/zero base → undefined
    }
    const valid = yoy.filter((y) => y.growthPct != null);
    const avg3 = valid.slice(0, 3).length ? valid.slice(0, 3).reduce((a, b) => a + b.growthPct, 0) / valid.slice(0, 3).length : null;
    const latest = yoy[0]?.growthPct ?? null;
    // composite raw for ranking: mean of latest and avg3
    const raw = latest != null && avg3 != null ? (latest + avg3) / 2 : latest ?? avg3;
    return { latest, avg3, yoy, raw, quarters: rows.length };
  }
  function nextEarnings(earnings, today) {
    const fut = (earnings || []).filter((e) => e.eps_actual == null && e.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
    return fut[0] || null;
  }

  // --- Pivot & buy zone: highest high over lookback bars (excluding current bar) ---
  function pivot(bars, lookback = 60) {
    const n = bars.length;
    if (n < 5) return null;
    const s = bars.slice(Math.max(0, n - 1 - lookback), n - 1);
    let p = -Infinity, at = null;
    for (const b of s) if (b.h > p) { p = b.h; at = b.t; }
    const c = bars[n - 1].c;
    return { pivot: p, date: at, zoneTop: p * 1.05, toPivotPct: (c / p - 1) * 100, inBuyZone: c >= p && c <= p * 1.05 };
  }

  // --- Simple base detection on WEEKLY bars (heuristic, not IBD pattern recognition) ---
  // Finds the most recent significant left-side high L (within last `maxWeeks`),
  // the lowest low after it (depth), and classifies the current status.
  function detectBase(weekly, opt = {}) {
    const maxWeeks = opt.maxWeeks || 65, minWeeks = opt.minWeeks || 7, minDepth = opt.minDepth || 8, maxDepth = opt.maxDepth || 50;
    const n = weekly.length;
    if (n < minWeeks + 2) return { status: 'none', reason: 'データ不足' };
    const start = Math.max(0, n - maxWeeks);
    const c = weekly[n - 1].c;
    let best = null;
    // candidate left highs: local maxima (higher than 3 weeks either side)
    for (let i = Math.max(start, 3); i <= n - minWeeks; i++) {
      const h = weekly[i].h;
      let isMax = true;
      for (let j = i - 3; j <= i + 3; j++) if (j !== i && j < n && weekly[j].h > h) { isMax = false; break; }
      if (!isMax) continue;
      let low = Infinity, lowAt = null;
      for (let j = i + 1; j < n; j++) if (weekly[j].l < low) { low = weekly[j].l; lowAt = weekly[j].t; }
      const depth = (1 - low / h) * 100;
      const weeks = n - 1 - i;
      if (depth < minDepth || depth > maxDepth || weeks < minWeeks) continue;
      // price must not have run > 20% above the left high (then this base already broke out long ago)
      if (c > h * 1.2) continue;
      const cand = { leftHigh: h, leftDate: weekly[i].t, low, lowDate: lowAt, depthPct: depth, weeks };
      if (!best || i > best.idx) best = { idx: i, ...cand }; // prefer the most recent qualifying high
    }
    if (!best) return { status: 'none', reason: '条件を満たすベースなし' };
    const pv = best.leftHigh;
    const dist = (c / pv - 1) * 100;
    let status, label;
    if (c >= pv && c <= pv * 1.05) { status = 'buyzone'; label = '買いゾーン内（ピボット〜+5%）'; }
    else if (c > pv * 1.05) { status = 'extended'; label = 'ブレイクアウト後・買いゾーン超過'; }
    else if (dist >= -5) { status = 'nearPivot'; label = 'ピボットまで5%以内'; }
    else if (dist >= -15) { status = 'rightSide'; label = 'ベース右側形成中'; }
    else { status = 'forming'; label = 'ベース形成中（底値圏）'; }
    const shape = best.depthPct <= 15 ? 'フラットベース候補' : best.depthPct <= 35 ? 'カップ型候補' : '深いベース（要注意）';
    return { status, label, shape, pivot: pv, zoneTop: pv * 1.05, toPivotPct: dist, ...best };
  }

  return { parseTwelveData, aggregate, sma, ema, rsi, macd, bollinger, atr, rsLine, summary, rsRaw, percentile, adRating, epsGrowth, nextEarnings, pivot, detectBase };
})();
if (typeof module !== 'undefined') module.exports = MSA;

// ===== Base-rate ("急騰の過去発生率") & bottom reference zone — evidence-only, no forecasting model =====
const MSB = (() => {
  const FEATS = [
    { k: 'rsi', label: 'RSI(14)', tol: 10, fmt: (v) => v.toFixed(0) },
    { k: 'dd', label: '高値からの下落率%', tol: 10, fmt: (v) => v.toFixed(0) + '%' },
    { k: 'ma200', label: '200日線乖離%', tol: 10, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(0) + '%' },
    { k: 'vol', label: '出来高/50日平均', tol: 0.5, fmt: (v) => v.toFixed(2) + 'x' },
    { k: 'rs', label: 'RS線20日変化%', tol: 5, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%' },
  ];
  // per-bar features + forward outcomes. bars ascending; bench optional (same dates)
  function features(bars, bench) {
    const closes = bars.map((b) => b.c);
    const rsi = MSA.rsi(closes, 14), ma200 = MSA.sma(closes, 200), volMa = MSA.sma(bars.map((b) => b.v), 50);
    const rsl = bench ? MSA.rsLine(bars, bench) : bars.map(() => null);
    const out = []; let peak = -Infinity;
    for (let i = 0; i < bars.length; i++) {
      peak = Math.max(peak, bars[i].c);
      const f = { i, t: bars[i].t, c: bars[i].c, rsi: rsi[i], dd: (1 - bars[i].c / peak) * 100, ma200: ma200[i] != null ? (bars[i].c / ma200[i] - 1) * 100 : null, vol: volMa[i] ? bars[i].v / volMa[i] : null, rs: i >= 20 && rsl[i] != null && rsl[i - 20] ? (rsl[i] / rsl[i - 20] - 1) * 100 : null };
      f.ok = FEATS.every((x) => f[x.k] != null && isFinite(f[x.k]));
      for (const h of [20, 60]) {
        if (i + h < bars.length) { let mx = -Infinity; for (let j = i + 1; j <= i + h; j++) mx = Math.max(mx, bars[j].c); f['ret' + h] = (bars[i + h].c / bars[i].c - 1) * 100; f['max' + h] = (mx / bars[i].c - 1) * 100; }
        else { f['ret' + h] = null; f['max' + h] = null; }
      }
      out.push(f);
    }
    return out;
  }
  function matches(hist, cur, width = 1, maxIdx = Infinity) {
    return hist.filter((f) => f.ok && f.i < maxIdx && FEATS.every((x) => Math.abs(f[x.k] - cur[x.k]) <= x.tol * width));
  }
  // collapse consecutive matched bars (< gap bars apart) into episodes → first bar of each
  function episodes(ms, gap = 10) { const out = []; let last = -Infinity, lastSym = null; for (const m of ms) { if (m.sym !== lastSym || m.i - last >= gap) out.push(m); last = m.i; lastSym = m.sym; } return out; }
  function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
  function stats(eps, h) {
    const withFwd = eps.filter((e) => e['ret' + h] != null);
    const n = withFwd.length; if (!n) return { n: 0 };
    const rets = withFwd.map((e) => e['ret' + h]), mxs = withFwd.map((e) => e['max' + h]);
    return { n, hit10: mxs.filter((v) => v >= 10).length / n * 100, hit20: mxs.filter((v) => v >= 20).length / n * 100, posRate: rets.filter((v) => v > 0).length / n * 100, p25: pct(rets, 0.25), med: pct(rets, 0.5), p75: pct(rets, 0.75), min: Math.min(...rets), max: Math.max(...rets) };
  }
  // main: current symbol's features (own history) + pooled histories [{sym, feats}]
  function baseRate(ownFeats, pool, width = 1) {
    const cur = ownFeats[ownFeats.length - 1];
    if (!cur || !cur.ok) return { ok: false, reason: '特徴量が計算できません（200日以上の日足が必要）' };
    const ownM = episodes(matches(ownFeats.slice(0, -1), cur, width).map((f) => ({ ...f, sym: 'own' })));
    const poolM = episodes(pool.flatMap((p) => matches(p.feats, cur, width).map((f) => ({ ...f, sym: p.sym }))));
    const uncOwn = { 20: stats(ownFeats.filter((f) => f.ok).map((f) => ({ ...f, sym: 'own' })), 20), 60: stats(ownFeats.filter((f) => f.ok).map((f) => ({ ...f, sym: 'own' })), 60) };
    return { ok: true, cur: FEATS.map((x) => ({ k: x.k, label: x.label, value: cur[x.k], text: x.fmt(cur[x.k]), tol: x.tol * width })), width,
      own: { n: ownM.length, h20: stats(ownM, 20), h60: stats(ownM, 60), recent: ownM.slice(-8).reverse().map((e) => ({ t: e.t, ret20: e.ret20, max20: e.max20, ret60: e.ret60, max60: e.max60 })) },
      pool: { n: poolM.length, symbols: [...new Set(poolM.map((m) => m.sym))].length, h20: stats(poolM, 20), h60: stats(poolM, 60) },
      unconditional: uncOwn };
  }
  // walk-forward check (own history only): at each past episode t, base rate computed from data before t vs realized outcome (max20 ≥ 10%)
  function walkForward(ownFeats, width = 1, h = 20, thr = 10, minTrain = 250) {
    const usable = ownFeats.filter((f) => f.ok && f['max' + h] != null);
    const pts = [];
    for (const f of usable) {
      if (f.i < minTrain) continue;
      const past = episodes(matches(ownFeats.slice(0, f.i - h), f, width).map((x) => ({ ...x, sym: 'own' }))).filter((x) => x['max' + h] != null);
      if (past.length < 5) continue;
      const p = past.filter((x) => x['max' + h] >= thr).length / past.length;
      pts.push({ t: f.t, p, y: f['max' + h] >= thr ? 1 : 0 });
    }
    const ep = episodes(pts.map((p, i) => ({ ...p, i, sym: 'own' })), 10);
    if (ep.length < 10) return { n: ep.length, note: '検証点が10未満のため評価不能' };
    const base = ep.reduce((s, x) => s + x.y, 0) / ep.length;
    const brier = ep.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / ep.length, brierBase = ep.reduce((s, x) => s + (base - x.y) ** 2, 0) / ep.length;
    const hi = ep.filter((x) => x.p >= 0.5), lo = ep.filter((x) => x.p < 0.5);
    return { n: ep.length, h, thr, baseRate: base * 100, brier, brierBase, skill: brierBase > 0 ? (1 - brier / brierBase) * 100 : null, hiN: hi.length, hiRealized: hi.length ? hi.reduce((s, x) => s + x.y, 0) / hi.length * 100 : null, loN: lo.length, loRealized: lo.length ? lo.reduce((s, x) => s + x.y, 0) / lo.length * 100 : null };
  }
  // bottom reference zone: collect price levels with sources, cluster within ±band
  function bottomZone(levels, price, band = 0.03) {
    const below = levels.filter((l) => l.price > 0 && l.price < price).sort((a, b) => b.price - a.price);
    const clusters = [];
    for (const l of below) { const c = clusters.find((cl) => Math.abs(cl.center / l.price - 1) <= band); if (c) { c.items.push(l); c.low = Math.min(c.low, l.price); c.high = Math.max(c.high, l.price); c.center = (c.low + c.high) / 2; } else clusters.push({ center: l.price, low: l.price, high: l.price, items: [l] }); }
    clusters.forEach((c) => { c.count = c.items.length; c.fromPricePct = (c.center / price - 1) * 100; });
    const thick = clusters.filter((c) => c.count >= 2).sort((a, b) => b.count - a.count || b.center - a.center);
    return { levels: below, clusters, thick, above: levels.filter((l) => l.price >= price) };
  }
  return { FEATS, features, baseRate, walkForward, bottomZone, matches, episodes, stats };
})();
if (typeof module !== 'undefined') module.exports.MSB = MSB;
