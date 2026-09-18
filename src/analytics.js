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
