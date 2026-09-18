// node test/run.js — fixture-based tests for parsers and analytics (no network)
'use strict';
const assert = require('assert');
const SEC = require('../scripts/lib/sec');
const AN = require('../scripts/lib/analysis');
const PR = require('../scripts/lib/prices');
const FETCH = require('../scripts/fetch');

// ---------- companyfacts fixture (fiscal year = calendar year; Q4 only via annual) ----------
const epsFacts = [];
let fy = 2022;
for (const y of [2022, 2023, 2024, 2025]) {
  const q = [['01-01', '03-31', 'Q1'], ['04-01', '06-30', 'Q2'], ['07-01', '09-30', 'Q3']];
  q.forEach(([s, e, fp], i) => epsFacts.push({ start: `${y}-${s}`, end: `${y}-${e}`, val: 1 + i * 0.1 + (y - 2022), accn: 'x', fy: y, fp, form: '10-Q', filed: `${y}-${e.slice(0, 2) === '03' ? '05-01' : e.slice(0, 2) === '06' ? '08-01' : '11-01'}` }));
  // annual: sum = 3 quarters + Q4 (=2 + y-2022)
  epsFacts.push({ start: `${y}-01-01`, end: `${y}-12-31`, val: +(1 + 1.1 + 1.2 + 3 * (y - 2022) + 2 + (y - 2022)).toFixed(4), accn: 'y', fy: y, fp: 'FY', form: '10-K', filed: `${y + 1}-02-15` });
  // a duplicate older filing of Q1 with a wrong value must lose to the later filed one
  epsFacts.push({ start: `${y}-01-01`, end: `${y}-03-31`, val: 99, accn: 'z', fy: y, fp: 'Q1', form: '10-Q', filed: `${y}-04-20` });
}
const facts = { facts: { 'us-gaap': { EarningsPerShareDiluted: { units: { 'USD/shares': epsFacts } } } } };
const qe = SEC.quarterlyEps(facts);
assert.strictEqual(qe.length, 16, 'quarters ' + qe.length);
assert.strictEqual(qe[0].end, '2022-03-31'); assert.strictEqual(qe[0].eps, 1);
const q4_2022 = qe.find((x) => x.end === '2022-12-31');
assert(q4_2022.derived && Math.abs(q4_2022.eps - 2) < 1e-6, 'derived Q4 ' + JSON.stringify(q4_2022));
assert.strictEqual(q4_2022.filed, '2023-02-15');
// latest-filed wins for duplicates (99 must not appear)
assert(!qe.some((x) => x.eps === 99));
const ttm = SEC.ttmSeries(qe);
assert.strictEqual(ttm.length, 13);
assert(Math.abs(ttm[0].ttm - (1 + 1.1 + 1.2 + 2)) < 1e-6);
assert.strictEqual(ttm[0].filed, '2023-02-15');

// ---------- submissions fixture ----------
const sub = { name: 'TEST CORP', filings: { recent: {
  form: ['8-K', '4', '10-Q', '8-K', '4/A', '4'],
  filingDate: ['2026-08-26', '2026-09-11', '2026-08-28', '2026-05-28', '2026-03-03', '2026-02-20'],
  acceptanceDateTime: ['2026-08-26T20:21:19.000Z', '2026-09-11T21:04:47.000Z', '2026-08-28T20:00:00.000Z', '2026-05-28T12:30:00.000Z', '2026-03-03T22:00:00.000Z', '2026-02-20T22:00:00.000Z'],
  accessionNumber: ['0001-26-000073', '0002-26-000005', '0001-26-000080', '0001-26-000050', '0002-26-000002', '0002-26-000001'],
  items: ['2.02,9.01', '', '', '2.02', '', ''],
  primaryDocument: ['nvda-8k.htm', 'xslF345X06/wk-form4_1.xml', 'q.htm', 'x.htm', 'xslF345X06/wk-form4_2.xml', 'wk-form4_3.xml'],
  reportDate: ['', '', '', '', '', ''],
} } };
const ev = SEC.earningsFilings(sub);
assert.strictEqual(ev.length, 2);
const r1 = SEC.reactionDate(ev[0].filingDate, ev[0].acceptance); // 20:21Z in Aug = 16:21 EDT → after close → next day
assert.deepStrictEqual(r1, { date: '2026-08-27', afterClose: true });
const r2 = SEC.reactionDate(ev[1].filingDate, ev[1].acceptance); // 12:30Z = 08:30 EDT → pre-market → same day
assert.deepStrictEqual(r2, { date: '2026-05-28', afterClose: false });
// EST case: 22:00Z in Feb = 17:00 EST → after close
assert.strictEqual(SEC.reactionDate('2026-02-20', '2026-02-20T22:00:00.000Z').date, '2026-02-21');
// 20:30Z in Feb = 15:30 EST → during session → same day
assert.strictEqual(SEC.reactionDate('2026-02-20', '2026-02-20T20:30:00.000Z').date, '2026-02-20');
const f4 = SEC.form4Filings(sub);
assert.strictEqual(f4.length, 3);
assert.strictEqual(f4[0].primaryDocument, 'wk-form4_1.xml', 'xsl prefix stripped');
assert.strictEqual(f4[2].primaryDocument, 'wk-form4_3.xml');

// ---------- Form 4 XML fixture ----------
const xml = `<?xml version="1.0"?><ownershipDocument><schemaVersion>X0508</schemaVersion><documentType>4</documentType><periodOfReport>2026-09-09</periodOfReport>
<issuer><issuerCik>0001045810</issuerCik><issuerName>NVIDIA CORP</issuerName><issuerTradingSymbol>NVDA</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>0001</rptOwnerCik><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-09-09</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare><value>150.25</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>51000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-09-10</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>200</value></transactionShares><transactionPricePerShare><value>151.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><transactionDate><value>2026-09-10</value></transactionDate><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>5000</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>
</nonDerivativeTable></ownershipDocument>`;
const p4 = SEC.parseForm4(xml);
assert.strictEqual(p4.issuer, 'NVDA');
assert.deepStrictEqual(p4.owners[0], { name: 'Doe Jane', roles: ['Director', 'Chief Financial Officer'] });
assert.strictEqual(p4.transactions.length, 3);
assert.deepStrictEqual(p4.transactions[0], { date: '2026-09-09', code: 'P', ad: 'A', shares: 1000, price: 150.25, value: 150250, owned: 51000, security: 'Common Stock' });
const ins = SEC.summarizeInsiders([{ filingDate: '2026-09-11', accession: 'a', parsed: p4 }, { filingDate: '2025-01-01', accession: 'b', parsed: { owners: [{ name: 'Old', roles: [] }], transactions: [{ date: '2025-01-01', code: 'P', shares: 10, price: 1, value: 10 }] } }], '2025-09-18');
assert.strictEqual(ins.buyCount, 1); assert.strictEqual(ins.buyValue, 150250); assert.strictEqual(ins.sellCount, 1); assert.strictEqual(ins.sellValue, 30200);
assert.strictEqual(ins.buyers[0].who, 'Doe Jane'); assert.strictEqual(ins.lastBuy, '2026-09-09');

// ---------- price parsers ----------
const stooq = 'Date,Open,High,Low,Close,Volume\n2026-09-16,100,101,99,100.5,1000\n2026-09-17,100.5,102,100,101.5,2000\n';
const sb = PR.parseStooqCsv(stooq); assert.strictEqual(sb.length, 2); assert.strictEqual(sb[1].c, 101.5);
assert.deepStrictEqual(PR.parseStooqCsv('Access denied'), []);
assert.deepStrictEqual(PR.parseStooqCsv('Exceeded the daily hits limit'), []);
const yj = { chart: { result: [{ timestamp: [1789000000, 1789086400], indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1.5], close: [1.5, null], volume: [10, 20] }] } }] } };
const yb = PR.parseYahooChart(yj); assert.strictEqual(yb.length, 1); assert.strictEqual(yb[0].c, 1.5);
const merged = PR.mergeBars([{ t: '2026-09-15', c: 1 }, { t: '2026-09-16', c: 2 }], sb); assert.strictEqual(merged.length, 3); assert.strictEqual(merged[1].c, 100.5);
assert.deepStrictEqual(PR.parseFredCsv('observation_date,DGS10\n2026-09-15,4.10\n2026-09-16,.\n2026-09-17,4.12\n'), [{ t: '2026-09-15', v: 4.1 }, { t: '2026-09-17', v: 4.12 }]);
assert.deepStrictEqual(PR.parseVixCsv('DATE,OPEN,HIGH,LOW,CLOSE\n09/17/2026,15.1,16,14.9,15.5\n'), [{ t: '2026-09-17', v: 15.5 }]);

// ---------- analytics ----------
// bars: 6 years daily, price = 20 * ttm-ish growth with noise → PE distribution around 20
const bars = []; { const d = new Date('2020-01-01T00:00:00Z'); let s = 7; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  while (bars.length < 1600) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; const t = d.toISOString().slice(0, 10); const yrs = (d - new Date('2020-01-01')) / 31557600000; const c = 20 * (2 + yrs) * (0.85 + rnd() * 0.3); bars.push({ t, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }); } }
// ttm eps ≈ 2 + yrs, filed quarterly
const ttmFx = []; for (let y = 2019; y <= 2026; y++) for (const [e, f] of [['03-31', '05-01'], ['06-30', '08-01'], ['09-30', '11-01'], ['12-31', '02-15']]) { const end = `${y}-${e}`; const filed = e === '12-31' ? `${y + 1}-${f}` : `${y}-${f}`; const yrs = (new Date(end) - new Date('2020-01-01')) / 31557600000; ttmFx.push({ end, filed, ttm: +(2 + yrs).toFixed(3) }); }
const pb = AN.peBand(bars, ttmFx, 5);
assert(pb && pb.samples > 1000, 'pe samples');
assert(pb.pe.p50 > 17 && pb.pe.p50 < 23, 'median PE ' + pb.pe.p50);
assert(pb.pe.p25 < pb.pe.p50 && pb.pe.p50 < pb.pe.p75);
assert(Math.abs(pb.band.p50 / pb.ttmEps - pb.pe.p50) < 0.02);
assert(pb.percentile >= 0 && pb.percentile <= 100);
// look-ahead guard: a ttm filed after the last bar must not be used
const pb2 = AN.peBand(bars, [...ttmFx, { end: '2026-12-31', filed: '2099-01-01', ttm: 1000 }], 5);
assert.strictEqual(pb2.ttmEps, pb.ttmEps);
// negative TTM → note
const pb3 = AN.peBand(bars, [{ end: '2019-12-31', filed: '2020-02-01', ttm: -1 }], 5);
assert(pb3 && pb3.note);
// drawdowns
const dd = AN.drawdowns([{ t: '1', c: 100 }, { t: '2', c: 80 }, { t: '3', c: 90 }, { t: '4', c: 101 }, { t: '5', c: 95 }, { t: '6', c: 70 }, { t: '7', c: 102 }, { t: '8', c: 100 }], 10);
assert.strictEqual(dd.count, 2); assert.strictEqual(dd.episodes[0].depthPct, 20); assert.strictEqual(dd.episodes[1].depthPct, 30.7);
assert.strictEqual(dd.current.depthPct, 2); assert.strictEqual(dd.current.peakDate, '7'); assert.strictEqual(dd.deeperCount, 2); assert.strictEqual(dd.max, 30.7);
// earnings reactions
const eb = [{ t: '2026-08-25', o: 100, c: 100 }, { t: '2026-08-26', o: 101, c: 102 }, { t: '2026-08-27', o: 110, c: 108 }, { t: '2026-08-28', o: 108, c: 109 }, { t: '2026-08-31', o: 109, c: 110 }, { t: '2026-09-01', o: 110, c: 111 }, { t: '2026-09-02', o: 111, c: 112 }];
const er = AN.earningsReactions(eb, [{ filingDate: '2026-08-26', reactionDate: '2026-08-27', afterClose: true }, { filingDate: '2026-09-30', reactionDate: '2026-10-01', afterClose: true }]);
assert.strictEqual(er.events.length, 2); assert(er.events[0].pending); const e0 = er.events[1];
assert.strictEqual(e0.prevClose, 102); assert.strictEqual(e0.reactionPct, 5.88); assert.strictEqual(e0.gapPct, 7.84); assert.strictEqual(e0.reaction5dPct, +((112 / 102 - 1) * 100).toFixed(2));
assert.strictEqual(er.n, 1); assert.strictEqual(er.upCount, 1);

// ---------- split-adjusted EPS (reproduces the real AVGO 10-for-1 case, 2024-07-15) ----------
// Periods last restated BEFORE the split keep pre-split values; periods restated after are already adjusted.
const SPLITS = [{ date: '2024-07-15', ratio: 10 }];
assert.strictEqual(SEC.splitFactorAfter(SPLITS, '2023-03-08'), 10);
assert.strictEqual(SEC.splitFactorAfter(SPLITS, '2024-09-11'), 1);
assert.strictEqual(SEC.splitFactorAfter([{ date: '2020-01-01', ratio: 4 }, { date: '2024-07-15', ratio: 10 }], '2021-01-01'), 10);
assert.strictEqual(SEC.splitFactorAfter([], '2020-01-01'), 1);
const avgoFacts = { facts: { 'us-gaap': { EarningsPerShareDiluted: { units: { 'USD/shares': [
  // pre-split filings only (value must be divided by 10)
  { start: '2022-10-31', end: '2023-01-29', val: 8.8, fy: 2023, fp: 'Q1', form: '10-Q', filed: '2023-03-08' },
  { start: '2022-10-31', end: '2023-01-29', val: 8.8, fy: 2024, fp: 'Q1', form: '10-Q', filed: '2024-03-14' },
  { start: '2023-01-30', end: '2023-04-30', val: 8.15, fy: 2023, fp: 'Q2', form: '10-Q', filed: '2023-06-07' },
  // restated after the split (already in post-split basis)
  { start: '2023-05-01', end: '2023-07-30', val: 7.74, fy: 2023, fp: 'Q3', form: '10-Q', filed: '2023-09-06' },
  { start: '2023-05-01', end: '2023-07-30', val: 0.77, fy: 2024, fp: 'Q3', form: '10-Q', filed: '2024-09-11' },
  // FY2023 annual, restated post-split → Q4 is derived from it
  { start: '2022-10-31', end: '2023-10-29', val: 32.98, fy: 2023, fp: 'FY', form: '10-K', filed: '2023-12-14' },
  { start: '2022-10-31', end: '2023-10-29', val: 3.3, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-12-20' },
] } } } } };
const adj = SEC.quarterlyEps(avgoFacts, SPLITS);
const byEnd = Object.fromEntries(adj.map((x) => [x.end, x]));
assert(Math.abs(byEnd['2023-01-29'].eps - 0.88) < 1e-6, 'pre-split Q1 rebased: ' + byEnd['2023-01-29'].eps);
assert(Math.abs(byEnd['2023-04-30'].eps - 0.815) < 1e-6);
assert(Math.abs(byEnd['2023-07-30'].eps - 0.77) < 1e-6, 'post-split Q3 untouched');
// first disclosure dates the series, not the later restatement
assert.strictEqual(byEnd['2023-01-29'].filed, '2023-03-08');
assert.strictEqual(byEnd['2023-07-30'].filed, '2023-09-06');
// derived Q4 = adjusted annual − the three adjusted quarters, all on one basis
const q4 = byEnd['2023-10-29'];
assert(q4.derived && Math.abs(q4.eps - (3.3 - (0.88 + 0.815 + 0.77))) < 1e-4, 'derived Q4 ' + JSON.stringify(q4));
assert(q4.eps > 0 && q4.eps < 1.2, 'derived Q4 in a sane range: ' + q4.eps);
// the whole point: a TTM sum over the four is now coherent
const avgoTtm = SEC.ttmSeries(adj);
assert.strictEqual(avgoTtm.length, 1);
assert(Math.abs(avgoTtm[0].ttm - 3.3) < 1e-4, 'TTM equals the restated FY: ' + avgoTtm[0].ttm);
// without split data the same facts produce the broken mix that shipped before this fix
const broken = SEC.quarterlyEps(avgoFacts, []);
const bQ4 = broken.find((x) => x.end === '2023-10-29');
assert(bQ4.eps < -10, 'regression guard: without split data the derived quarter is absurd (' + bQ4.eps + ')');
assert(broken.find((x) => x.end === '2023-01-29').eps === 8.8 && broken.find((x) => x.end === '2023-07-30').eps === 0.77,
  'regression guard: pre- and post-split quarters sit side by side when unadjusted');

// ---------- split parsing ----------
assert.deepStrictEqual(PR.parseYahooSplits({ chart: { result: [{ events: { splits: {
  '1721053800': { date: 1721053800, numerator: 10, denominator: 1, splitRatio: '10:1' },
  '1656941400': { date: 1656941400, numerator: 20, denominator: 1, splitRatio: '20:1' },
} } }] } }), [{ date: '2022-07-04', ratio: 20 }, { date: '2024-07-15', ratio: 10 }]);
assert.deepStrictEqual(PR.parseYahooSplits({}), []);
assert.strictEqual(PR.parseYahooSplits({ chart: { result: [{ events: { splits: { a: { date: 1721053800, splitRatio: '1:10' } } } }] } })[0].ratio, 0.1);

// ---------- partial (in-progress) bar ----------
const partBars = [{ t: '2026-09-17', c: 1 }, { t: '2026-09-18', c: 2 }];
// 2026-09-18 13:54Z = 09:54 ET (EDT) → session open → last bar is partial
assert.deepStrictEqual(PR.dropPartialBar(partBars, Date.parse('2026-09-18T13:54:00Z')).dropped, '2026-09-18');
// 22:30Z = 18:30 ET → after the close → keep it
assert.strictEqual(PR.dropPartialBar(partBars, Date.parse('2026-09-18T22:30:00Z')).dropped, null);
assert.strictEqual(PR.dropPartialBar(partBars, Date.parse('2026-09-18T22:30:00Z')).bars.length, 2);
// winter (EST): 21:30Z = 16:30 ET → after the close
assert.strictEqual(PR.dropPartialBar([{ t: '2026-01-15' }], Date.parse('2026-01-15T21:30:00Z')).dropped, null);
assert.strictEqual(PR.dropPartialBar([{ t: '2026-01-15' }], Date.parse('2026-01-15T18:00:00Z')).dropped, '2026-01-15');
assert.strictEqual(PR.dropPartialBar([], Date.now()).dropped, null);

// ---------- peBand excludes earnings troughs instead of letting them blow up the upper percentiles ----------
const tBars = [], tTtm = [{ end: '2019-12-31', filed: '2020-01-02', ttm: 10 }];
{ const d = new Date('2020-01-01T00:00:00Z');
  while (tBars.length < 1300) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue; tBars.push({ t: d.toISOString().slice(0, 10), c: 200 }); } }
// a 60-day collapse to EPS 0.2 in the middle of the window
tTtm.push({ end: '2022-12-31', filed: tBars[600].t, ttm: 0.2 }, { end: '2023-03-31', filed: tBars[660].t, ttm: 10 });
const bandT = AN.peBand(tBars, tTtm, 10);
assert.strictEqual(bandT.excludedTrough, 60, 'trough days excluded: ' + bandT.excludedTrough);
assert(Math.abs(bandT.pe.p90 - 20) < 0.01, 'p90 stays at the healthy-earnings P/E: ' + bandT.pe.p90);
assert(bandT.caveat.includes('減益期'));
const bandNo = AN.peBand(tBars, [tTtm[0]], 10);
assert.strictEqual(bandNo.excludedTrough, 0); assert.strictEqual(bandNo.caveat, ''); assert.strictEqual(bandNo.suspect, false);
// a band whose spread is still absurd after filtering is flagged rather than presented as precise
const wideTtm = [{ end: '2019-12-31', filed: '2020-01-02', ttm: 10 }];
const wideBars = tBars.map((b, i) => ({ t: b.t, c: i < 650 ? 30 : 600 }));
const bandWide = AN.peBand(wideBars, wideTtm, 10);
assert(bandWide.suspect && bandWide.spread > 10 && bandWide.caveat.includes('価格の目安になりません'), 'wide spread flagged: ' + JSON.stringify({ s: bandWide.spread, c: bandWide.caveat }));
// the warning must state the measured cause (the EPS swing), never blame a stock split it cannot see
assert(!bandWide.caveat.includes('株式分割'), 'no unfounded split blame');
assert(bandWide.ttmLow === 10 && bandWide.ttmHigh === 10, 'EPS range reported: ' + JSON.stringify([bandWide.ttmLow, bandWide.ttmHigh]));

// ---------- health check: stale-but-green is the failure mode this guards against ----------
const NOW = Date.parse('2026-09-19T12:00:00Z');
const mkIndex = (lastDate, n = 11) => ({ symbols: Array.from({ length: n }, (_, i) => ({ symbol: 'S' + i, lastDate })), macro: { errors: [] } });
const okRun = FETCH.healthCheck(mkIndex('2026-09-18'), [], 11, NOW);
assert(okRun.ok && !okRun.problems.length && !okRun.warnings.length, JSON.stringify(okRun));
assert.strictEqual(okRun.newestBar, '2026-09-18');
// a few price failures are a warning, not a failure — the previous bars still carry the page
const few = FETCH.healthCheck(mkIndex('2026-09-18'), ['AVGO'], 11, NOW);
assert(few.ok && few.warnings.length === 1 && !few.problems.length, JSON.stringify(few));
// a third of the list failing is a real outage → red run
const many = FETCH.healthCheck(mkIndex('2026-09-18'), ['A', 'B', 'C', 'D'], 11, NOW);
assert(!many.ok && many.problems[0].includes('4/11'), JSON.stringify(many));
// data that quietly stopped advancing → red run
const stale = FETCH.healthCheck(mkIndex('2026-09-10'), [], 11, NOW);
assert(!stale.ok && stale.problems.some((p) => p.includes('古すぎます')), JSON.stringify(stale));
assert(FETCH.healthCheck(mkIndex('2026-09-14'), [], 11, NOW).ok, 'a long weekend is not staleness');
// nothing at all
const empty = FETCH.healthCheck({ symbols: [], macro: { errors: [] } }, [], 11, NOW);
assert(!empty.ok && empty.problems.some((p) => p.includes('どの銘柄も')), JSON.stringify(empty));
// one symbol lagging the rest is surfaced but does not fail the run
const lag = mkIndex('2026-09-18'); lag.symbols[3].lastDate = '2026-09-11';
const lagged = FETCH.healthCheck(lag, [], 11, NOW);
assert(lagged.ok && lagged.warnings.some((w) => w.includes('S3(2026-09-11)')), JSON.stringify(lagged));
// macro errors are reported, never fatal
const mac = FETCH.healthCheck(Object.assign(mkIndex('2026-09-18'), { macro: { errors: ['VIX HTTP 503'] } }), [], 11, NOW);
assert(mac.ok && mac.warnings.some((w) => w.includes('VIX HTTP 503')));

console.log('ALL TESTS PASSED');
