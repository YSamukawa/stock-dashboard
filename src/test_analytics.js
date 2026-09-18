const A = require('./analytics.js');
const assert = require('assert');

// synthetic daily bars: 400 trading days, cup shape at the end
function gen(seed = 1) {
  let s = seed; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const bars = []; let d = new Date('2025-01-01T00:00:00Z'); let p = 100;
  for (let i = 0; bars.length < 400; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const k = bars.length;
    let drift = 0.0006;
    if (k > 280 && k <= 330) drift = -0.004; // decline
    if (k > 330) drift = 0.0035;             // recovery
    p *= 1 + drift + (rnd() - 0.5) * 0.02;
    const o = p * (1 + (rnd() - 0.5) * 0.01), c = p, h = Math.max(o, c) * (1 + rnd() * 0.01), l = Math.min(o, c) * (1 - rnd() * 0.01);
    bars.push({ datetime: d.toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: Math.round(1e6 * (0.5 + rnd())) });
  }
  return bars;
}
const raw = gen();
const bars = A.parseTwelveData(raw.slice().reverse()); // TD is newest-first
assert.strictEqual(bars.length, 400);
assert(bars[0].t < bars[1].t, 'ascending');

// aggregation
const wk = A.aggregate(bars, 'week');
assert(wk.length > 70 && wk.length < 90, 'weekly count ' + wk.length);
const w0 = wk[10];
assert(w0.h >= w0.o && w0.h >= w0.c && w0.l <= w0.o && w0.l <= w0.c);
const sumV = bars.reduce((a, b) => a + b.v, 0), sumW = wk.reduce((a, b) => a + b.v, 0);
assert.strictEqual(sumV, sumW, 'volume conserved');
const mo = A.aggregate(bars, 'month');
assert(mo.length >= 18 && mo.length <= 20, 'monthly ' + mo.length);

// sma / ema
const closes = bars.map((b) => b.c);
const s5 = A.sma([1, 2, 3, 4, 5, 6], 3);
assert.deepStrictEqual(s5, [null, null, 2, 3, 4, 5]);
const e3 = A.ema([1, 2, 3, 4, 5], 3);
assert.strictEqual(e3[2], 2); assert(Math.abs(e3[3] - 3) < 1e-9); assert(Math.abs(e3[4] - 4) < 1e-9);
const s50 = A.sma(closes, 50);
assert(s50[48] === null && s50[49] !== null);
assert(Math.abs(s50[399] - closes.slice(350).reduce((a, b) => a + b) / 50) < 1e-9);

// rsi range & known case
const r = A.rsi(closes, 14);
assert(r[13] === null && r[14] !== null);
assert(r.slice(14).every((x) => x >= 0 && x <= 100));
const up = A.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
assert.strictEqual(up[14], 100);

// macd
const m = A.macd(closes);
assert(m.line[24] === null && m.line[25] !== null);
assert(m.signal[33] !== null && m.hist[40] !== null);

// bollinger
const bb = A.bollinger(closes, 20, 2);
assert(bb.up[30] > bb.mid[30] && bb.lo[30] < bb.mid[30]);

// atr
const at = A.atr(bars, 14);
assert(at[12] === null && at[13] > 0);

// rsLine
const bench = bars.map((b) => ({ ...b, c: 50 }));
const rl = A.rsLine(bars, bench);
assert(Math.abs(rl[100] - bars[100].c / 50) < 1e-12);
const benchMissing = bench.filter((_, i) => i !== 100);
const rl2 = A.rsLine(bars, benchMissing);
assert(Math.abs(rl2[100] - bars[100].c / 50) < 1e-12, 'carry forward');

// summary
const sm = A.summary(bars);
assert(sm.hi52 >= sm.close && sm.lo52 <= sm.close);
assert(sm.fromHi52Pct <= 0 && sm.fromLo52Pct >= 0);
assert(sm.avgVol50 > 0 && typeof sm.volRatePct === 'number');

// rsRaw & percentile
const rr = A.rsRaw(bars);
assert(typeof rr === 'number');
const c = closes[399];
const expect = 0.4 * (c / closes[399 - 63]) + 0.2 * (c / closes[399 - 126]) + 0.2 * (c / closes[399 - 189]) + 0.2 * (c / closes[399 - 252]);
assert(Math.abs(rr - expect) < 1e-12, 'rs raw');
assert.strictEqual(A.percentile(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), Math.round((4.5 / 10) * 98 + 1));
assert.strictEqual(A.percentile(10, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 94);
assert.strictEqual(A.percentile(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 6);
assert.strictEqual(A.percentile(1, [1]), null);
assert.strictEqual(A.rsRaw(bars.slice(0, 30)), null);

// adRating
const ad = A.adRating(bars);
assert(['A', 'B', 'C', 'D', 'E'].includes(ad.grade));
const allUp = []; for (let i = 0; i < 60; i++) allUp.push({ t: 'x', o: 1, h: 1, l: 1, c: i, v: 100 });
assert.strictEqual(A.adRating(allUp).grade, 'A');

// epsGrowth
const earn = [
  { date: '2026-09-30', eps_actual: null, eps_estimate: 2 },
  { date: '2026-06-30', eps_actual: 2.4 }, { date: '2026-03-31', eps_actual: 2.2 }, { date: '2025-12-31', eps_actual: 2.0 }, { date: '2025-09-30', eps_actual: 1.8 },
  { date: '2025-06-30', eps_actual: 2.0 }, { date: '2025-03-31', eps_actual: 2.0 }, { date: '2024-12-31', eps_actual: 1.6 }, { date: '2024-09-30', eps_actual: -0.5 },
];
const eg = A.epsGrowth(earn);
assert(Math.abs(eg.latest - 20) < 1e-9, 'latest ' + eg.latest);
assert(Math.abs(eg.yoy[1].growthPct - 10) < 1e-9);
assert(Math.abs(eg.yoy[2].growthPct - 25) < 1e-9);
assert.strictEqual(eg.yoy[3].growthPct, null, 'negative base');
assert(Math.abs(eg.avg3 - (20 + 10 + 25) / 3) < 1e-9);
assert.strictEqual(A.nextEarnings(earn, '2026-09-18').date, '2026-09-30');
assert.strictEqual(A.nextEarnings(earn, '2026-10-01'), null);

// pivot
const pv = A.pivot(bars, 60);
const expPivot = Math.max(...bars.slice(339, 399).map((b) => b.h));
assert.strictEqual(pv.pivot, expPivot);
assert(Math.abs(pv.zoneTop - expPivot * 1.05) < 1e-9);

// detectBase on cup-shaped synthetic weekly
const base = A.detectBase(wk);
console.log('base:', base);
assert(base.status !== 'none', 'should find base');
assert(base.depthPct > 8 && base.weeks >= 7);
assert(base.low < base.leftHigh);
// flat series → none
const flat = []; for (let i = 0; i < 80; i++) flat.push({ t: 'd' + i, o: 100, h: 101, l: 99, c: 100, v: 1 });
assert.strictEqual(A.detectBase(flat).status, 'none');

console.log('ALL TESTS PASSED');
console.log('summary:', sm);
console.log('rs raw:', rr, 'ad:', ad, 'pivot:', pv);
