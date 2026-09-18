const A = require('./analytics.js'); const MSB = A.MSB; const assert = require('assert');
function gen(seed, n = 1200) { let s = seed; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; const bars = []; let d = new Date('2021-01-01T00:00:00Z'); let p = 100; while (bars.length < n) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; p *= 1 + 0.0004 + Math.sin(bars.length / 70) * 0.004 + (rnd() - 0.5) * 0.03; bars.push({ t: d.toISOString().slice(0, 10), o: p, h: p * 1.01, l: p * 0.99, c: p, v: Math.round(1e6 * (0.5 + rnd())) }); } return bars; }
const bars = gen(3), bench = gen(9);
const f = MSB.features(bars, bench);
assert.strictEqual(f.length, bars.length); assert(!f[100].ok && f[300].ok, 'ok flag');
assert.strictEqual(f[bars.length - 1].ret20, null); assert(typeof f[500].ret20 === 'number' && f[500].max20 >= f[500].ret20 - 1e-9);
assert(Math.abs(f[500].ret60 - (bars[560].c / bars[500].c - 1) * 100) < 1e-9);
assert(f[500].dd >= 0);
const pool = [{ sym: 'X', feats: MSB.features(gen(5), bench) }, { sym: 'Y', feats: MSB.features(gen(7), bench) }];
const br = MSB.baseRate(f, pool, 1);
assert(br.ok); assert(br.cur.length === 5); assert(br.own.n >= 0 && br.pool.n >= br.pool.symbols);
if (br.own.h20.n) { assert(br.own.h20.hit10 >= 0 && br.own.h20.hit10 <= 100); assert(br.own.h20.p25 <= br.own.h20.med && br.own.h20.med <= br.own.h20.p75); }
const cur = f[f.length - 1]; assert(MSB.matches(f.slice(0, -1), cur, 2).length >= MSB.matches(f.slice(0, -1), cur, 1).length, 'wider → more raw matches');
// episodes collapse consecutive
const ep = MSB.episodes([{ i: 1, sym: 'a' }, { i: 3, sym: 'a' }, { i: 30, sym: 'a' }, { i: 31, sym: 'b' }]); assert.strictEqual(ep.length, 3);
// stats
const st = MSB.stats([{ ret20: 5, max20: 12 }, { ret20: -3, max20: 2 }, { ret20: 25, max20: 30 }, { ret20: null, max20: null }], 20);
assert.strictEqual(st.n, 3); assert(Math.abs(st.hit10 - 66.67) < 0.1); assert(Math.abs(st.hit20 - 33.33) < 0.1); assert.strictEqual(st.med, 5);
// walk-forward
const wf = MSB.walkForward(f, 1.5, 20, 10);
assert(wf.n >= 0); if (wf.n >= 10) { assert(wf.brier >= 0 && wf.brier <= 1); assert(wf.hiN + wf.loN === wf.n); }
// bottom zone clustering
const bz = MSB.bottomZone([{ src: 'A', price: 90 }, { src: 'B', price: 91 }, { src: 'C', price: 80 }, { src: 'D', price: 110 }, { src: 'E', price: 0 }], 100, 0.03);
assert.strictEqual(bz.levels.length, 3); assert.strictEqual(bz.clusters.length, 2); assert.strictEqual(bz.thick.length, 1); assert.strictEqual(bz.thick[0].count, 2); assert.strictEqual(bz.above.length, 1);
console.log('BASE-RATE TESTS PASSED', JSON.stringify({ own: br.own.n, pool: br.pool.n, wf: wf.n, skill: wf.skill }));
