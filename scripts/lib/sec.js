// SEC EDGAR parsers — pure functions, no network. Tested in test/sec.test.js
'use strict';

// ---- companyfacts → quarterly diluted EPS series ----
// facts: the JSON from data.sec.gov/api/xbrl/companyfacts/CIK##########.json
// Returns ascending [{end, start, eps, fy, fp, form, filed, derived}] with one value per quarter end.
function quarterlyEps(facts) {
  const gaap = facts?.facts?.['us-gaap'] || {};
  const node = gaap.EarningsPerShareDiluted || gaap.EarningsPerShareBasic;
  if (!node) return [];
  const arr = node.units?.['USD/shares'] || [];
  const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;
  const q = new Map(); // end -> fact (3-month duration)
  const annual = new Map(); // end -> fact (~12-month duration)
  for (const f of arr) {
    if (!f.start || !f.end || typeof f.val !== 'number') continue;
    const d = days(f.start, f.end);
    if (d >= 75 && d <= 100) { const prev = q.get(f.end); if (!prev || f.filed > prev.filed) q.set(f.end, f); }
    else if (d >= 350 && d <= 380) { const prev = annual.get(f.end); if (!prev || f.filed > prev.filed) annual.set(f.end, f); }
  }
  // derive Q4 (or any missing quarter) = annual − the three quarters inside the annual window
  for (const [end, a] of annual) {
    if (q.has(end)) continue;
    const inside = [...q.values()].filter((x) => x.end > a.start && x.end < a.end && days(a.start, x.end) > 60);
    if (inside.length === 3) q.set(end, { start: inside[2].end, end, val: +(a.val - inside.reduce((s, x) => s + x.val, 0)).toFixed(4), fy: a.fy, fp: 'Q4', form: a.form, filed: a.filed, derived: true });
  }
  return [...q.values()].sort((x, y) => (x.end < y.end ? -1 : 1)).map((f) => ({ end: f.end, start: f.start, eps: f.val, fy: f.fy, fp: f.fp, form: f.form, filed: f.filed, derived: !!f.derived }));
}
// TTM EPS series: [{end, filed, ttm}] (sum of 4 consecutive quarters; requires gaps ≤ ~100 days)
function ttmSeries(qeps) {
  const out = [];
  for (let i = 3; i < qeps.length; i++) {
    const w = qeps.slice(i - 3, i + 1);
    const span = (new Date(w[3].end) - new Date(w[0].end)) / 86400000;
    if (span < 250 || span > 300) continue; // not four consecutive quarters
    out.push({ end: w[3].end, filed: w.reduce((m, x) => (x.filed > m ? x.filed : m), ''), ttm: +w.reduce((s, x) => s + x.eps, 0).toFixed(4) });
  }
  return out;
}

// ---- submissions → earnings (8-K Item 2.02) and Form 4 list ----
function recentFilings(sub) {
  const r = sub?.filings?.recent; if (!r) return [];
  const n = r.form.length, out = [];
  for (let i = 0; i < n; i++) out.push({ form: r.form[i], filingDate: r.filingDate[i], acceptance: r.acceptanceDateTime[i], accession: r.accessionNumber[i], items: r.items?.[i] || '', primaryDocument: r.primaryDocument?.[i] || '', reportDate: r.reportDate?.[i] || '' });
  return out;
}
function earningsFilings(sub) {
  return recentFilings(sub).filter((f) => f.form === '8-K' && /(^|,)\s*2\.02(,|$)/.test(f.items)).map((f) => ({ filingDate: f.filingDate, acceptance: f.acceptance, accession: f.accession }));
}
function form4Filings(sub) {
  return recentFilings(sub).filter((f) => f.form === '4' || f.form === '4/A').map((f) => ({ form: f.form, filingDate: f.filingDate, accession: f.accession, primaryDocument: f.primaryDocument.replace(/^xsl[^/]+\//, '') }));
}
// Reaction trading day for a filing: after 16:00 ET → next trading day; else same day. Returns YYYY-MM-DD (ET calendar date).
function reactionDate(filingDate, acceptanceISO) {
  if (!acceptanceISO) return { date: filingDate, afterClose: null };
  const dt = new Date(acceptanceISO);
  // ET offset: EDT (UTC-4) Mar 2nd Sun → Nov 1st Sun; approximate by month/day rule
  const y = dt.getUTCFullYear();
  const nthSunday = (m, n) => { const d = new Date(Date.UTC(y, m, 1)); const first = (7 - d.getUTCDay()) % 7 + 1; return new Date(Date.UTC(y, m, first + 7 * (n - 1), 7)); };
  const dstStart = nthSunday(2, 2), dstEnd = nthSunday(10, 1);
  const off = dt >= dstStart && dt < dstEnd ? -4 : -5;
  const et = new Date(dt.getTime() + off * 3600e3);
  const etDate = et.toISOString().slice(0, 10), hour = et.getUTCHours() + et.getUTCMinutes() / 60;
  const afterClose = hour >= 16;
  if (!afterClose && hour < 9.5) return { date: etDate, afterClose: false };
  if (afterClose) { const nx = new Date(et); nx.setUTCDate(nx.getUTCDate() + 1); return { date: nx.toISOString().slice(0, 10), afterClose: true }; }
  return { date: etDate, afterClose: false }; // filed during session → same day
}

// ---- Form 4 XML → transactions ----
function tag(xml, name) { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : ''; }
function val(xml, name) { const inner = tag(xml, name); return inner ? tag(inner, 'value') || inner : ''; }
function parseForm4(xml) {
  const owners = [...xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/g)].map((m) => {
    const o = m[1];
    const rel = tag(o, 'reportingOwnerRelationship');
    const roles = [];
    if (/<isDirector>\s*(1|true)/.test(rel)) roles.push('Director');
    if (/<isOfficer>\s*(1|true)/.test(rel)) roles.push(tag(rel, 'officerTitle') || 'Officer');
    if (/<isTenPercentOwner>\s*(1|true)/.test(rel)) roles.push('10% Owner');
    if (/<isOther>\s*(1|true)/.test(rel)) roles.push(tag(rel, 'otherText') || 'Other');
    return { name: tag(o, 'rptOwnerName'), roles };
  });
  const issuer = tag(xml, 'issuerTradingSymbol');
  const periodOfReport = tag(xml, 'periodOfReport');
  const tx = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)].map((m) => {
    const t = m[1];
    const code = val(t, 'transactionCode');
    const shares = parseFloat(val(t, 'transactionShares')) || 0;
    const price = parseFloat(val(t, 'transactionPricePerShare')) || 0;
    const ad = val(t, 'transactionAcquiredDisposedCode');
    const date = val(t, 'transactionDate');
    const owned = parseFloat(val(t, 'sharesOwnedFollowingTransaction')) || null;
    const security = val(t, 'securityTitle');
    return { date, code, ad, shares, price, value: +(shares * price).toFixed(2), owned, security };
  });
  return { issuer, periodOfReport, owners, transactions: tx };
}
// Aggregate parsed Form 4s (each {filingDate, accession, parsed}) over a window → summary
function summarizeInsiders(filings, sinceDate) {
  const buys = [], sells = [];
  for (const f of filings) {
    if (!f.parsed) continue;
    const who = f.parsed.owners.map((o) => o.name).join('; ') || '?';
    const role = f.parsed.owners.flatMap((o) => o.roles).join('/') || '';
    for (const t of f.parsed.transactions) {
      if (t.date < sinceDate) continue;
      const rec = { date: t.date, who, role, shares: t.shares, price: t.price, value: t.value, accession: f.accession };
      if (t.code === 'P') buys.push(rec);
      else if (t.code === 'S') sells.push(rec);
    }
  }
  const sum = (a) => a.reduce((s, x) => s + x.value, 0);
  const byOwner = (a) => { const m = {}; for (const x of a) { m[x.who] = m[x.who] || { who: x.who, role: x.role, n: 0, shares: 0, value: 0, last: '' }; const o = m[x.who]; o.n++; o.shares += x.shares; o.value += x.value; if (x.date > o.last) o.last = x.date; } return Object.values(m).sort((p, q) => q.value - p.value); };
  return { since: sinceDate, buyCount: buys.length, buyValue: +sum(buys).toFixed(0), sellCount: sells.length, sellValue: +sum(sells).toFixed(0), buyers: byOwner(buys), sellers: byOwner(sells).slice(0, 8), lastBuy: buys.map((b) => b.date).sort().pop() || null, recentBuys: buys.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12) };
}

module.exports = { quarterlyEps, ttmSeries, recentFilings, earningsFilings, form4Filings, reactionDate, parseForm4, summarizeInsiders };
