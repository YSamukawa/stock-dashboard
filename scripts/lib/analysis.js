// Derived analytics for the repo data files — pure functions. Tested in test/analysis.test.js
'use strict';
function pct(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }

// ---- P/E band: price / TTM EPS known as of each date (uses `filed` to avoid look-ahead) ----
// bars ascending [{t,c}], ttm ascending [{end, filed, ttm}]
function peBand(bars, ttm, years = 5) {
  if (!bars.length || !ttm.length) return null;
  const since = new Date(bars[bars.length - 1].t); since.setFullYear(since.getFullYear() - years);
  const sinceStr = since.toISOString().slice(0, 10);
  const pes = []; let j = 0, cur = null;
  const series = [];
  for (const b of bars) {
    while (j < ttm.length && ttm[j].filed <= b.t) { cur = ttm[j]; j++; }
    if (!cur || cur.ttm <= 0) continue;
    const pe = b.c / cur.ttm;
    if (b.t >= sinceStr) { pes.push(pe); series.push({ t: b.t, pe: +pe.toFixed(2) }); }
  }
  const last = bars[bars.length - 1];
  const curTtm = [...ttm].reverse().find((x) => x.filed <= last.t);
  if (!curTtm || curTtm.ttm <= 0) return { ttmEps: curTtm?.ttm ?? null, ttmEnd: curTtm?.end ?? null, note: 'TTM EPSが0以下のためPERは算出不能', samples: pes.length };
  if (!pes.length) return null;
  const P = { p10: pct(pes, 0.1), p25: pct(pes, 0.25), p50: pct(pes, 0.5), p75: pct(pes, 0.75), p90: pct(pes, 0.9) };
  const curPe = last.c / curTtm.ttm;
  const rank = pes.filter((x) => x < curPe).length / pes.length;
  const band = {}; for (const k in P) band[k] = +(P[k] * curTtm.ttm).toFixed(2);
  return { ttmEps: curTtm.ttm, ttmEnd: curTtm.end, curPe: +curPe.toFixed(2), percentile: +(rank * 100).toFixed(0), pe: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, +v.toFixed(2)])), band, samples: pes.length, years, series: series.filter((_, i) => i % 5 === 0) };
}

// ---- Drawdown episodes from running max ----
function drawdowns(bars, minDepth = 10) {
  const eps = []; let peak = -Infinity, peakT = null, trough = Infinity, troughT = null, inDD = false;
  for (const b of bars) {
    if (b.c >= peak) {
      if (inDD && (1 - trough / peak) * 100 >= minDepth) eps.push({ peakDate: peakT, troughDate: troughT, recoverDate: b.t, depthPct: +((1 - trough / peak) * 100).toFixed(1), peak: +peak.toFixed(2), trough: +trough.toFixed(2) });
      peak = b.c; peakT = b.t; trough = b.c; troughT = b.t; inDD = false;
    } else {
      inDD = true;
      if (b.c < trough) { trough = b.c; troughT = b.t; }
    }
  }
  const last = bars[bars.length - 1];
  const current = { peakDate: peakT, peak: +peak.toFixed(2), trough: +trough.toFixed(2), troughDate: troughT, depthPct: +((1 - last.c / peak) * 100).toFixed(1), maxDepthPct: +((1 - trough / peak) * 100).toFixed(1), days: Math.round((new Date(last.t) - new Date(peakT)) / 86400000) };
  const depths = eps.map((e) => e.depthPct);
  const deeper = depths.filter((d) => d > current.depthPct).length;
  return { current, episodes: eps.slice(-12), count: eps.length, median: depths.length ? +pct(depths, 0.5).toFixed(1) : null, p75: depths.length ? +pct(depths, 0.75).toFixed(1) : null, max: depths.length ? Math.max(...depths) : null, deeperCount: deeper, rankNote: depths.length ? `過去${depths.length}回の${minDepth}%以上の下落局面のうち、現在より深いものは${deeper}回` : '過去に該当する下落局面なし' };
}

// ---- Earnings reactions: for each reaction date, close(reaction)/close(prev) - 1, and 5-day ----
function earningsReactions(bars, events) {
  const idx = new Map(bars.map((b, i) => [b.t, i]));
  const times = bars.map((b) => b.t);
  const out = [];
  for (const ev of events) {
    let i = idx.get(ev.reactionDate);
    if (i == null) { i = times.findIndex((t) => t >= ev.reactionDate); if (i < 0) { out.push({ ...ev, pending: true }); continue; } }
    if (i < 1) continue;
    const prev = bars[i - 1].c, r1 = bars[i].c, r5 = bars[Math.min(i + 4, bars.length - 1)].c;
    out.push({ ...ev, tradeDate: bars[i].t, prevClose: +prev.toFixed(2), close: +r1.toFixed(2), reactionPct: +((r1 / prev - 1) * 100).toFixed(2), reaction5dPct: i + 4 < bars.length ? +((r5 / prev - 1) * 100).toFixed(2) : null, gapPct: +((bars[i].o / prev - 1) * 100).toFixed(2) });
  }
  out.sort((a, b) => (a.reactionDate < b.reactionDate ? 1 : -1));
  const r = out.filter((x) => x.reactionPct != null).map((x) => x.reactionPct);
  return { events: out.slice(0, 12), avgAbsMove: r.length ? +(r.reduce((s, x) => s + Math.abs(x), 0) / r.length).toFixed(2) : null, upCount: r.filter((x) => x > 0).length, n: r.length };
}

module.exports = { pct, peBand, drawdowns, earningsReactions };
