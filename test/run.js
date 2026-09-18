// node test/run.js — fixture-based tests for parsers and analytics (no network)
'use strict';
const assert = require('assert');
const SEC = require('../scripts/lib/sec');
const AN = require('../scripts/lib/analysis');
const PR = require('../scripts/lib/prices');

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

console.log('ALL TESTS PASSED');
