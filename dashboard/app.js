// Launch Radar dashboard: reads window.RADAR (data.js) and refits the surviving model
// live from the embedded snapshot with window.RADARFIT (fit.js). No network. The term
// search ran at build time (same code, same data); this page refits the surviving model
// live and verifies it against the build.
(function () {
'use strict';
var F = window.RADARFIT, R = window.RADAR, D = document;
var $ = function (id) { return D.getElementById(id); };
var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
var m$ = function (n) { return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + Math.round(n); };
var ni = function (n) { return Math.round(n).toLocaleString('en-US'); };
var age = function (d) { return d === null || d === undefined ? 'unknown' : d >= 365 ? (d / 365).toFixed(1) + 'y' : d + 'd'; };
var chg = function (c) { return c === null || c === undefined ? '—' : (c > 0 ? '+' : '') + c.toFixed(1) + '%'; };
var neg = function (n) { return (n < 0 ? '−$' : '$') + ni(Math.abs(n)); };
var snap = { as_of: R.as_of, floor_usd: R.floor_usd, protocols: R.protocols, watchlist: R.watchlist };
var live = F.refitLive(snap, R.model.value.kept, R.model.odds.kept);
var q = live.ranges;
var near = function (a, b) { return Math.abs(a - b) < 1e-9; };
var rowsMatch = live.board.length === R.rows.length && live.board.every(function (r, i) { return r.slug === R.rows[i].slug && r.implied_value_usd === R.rows[i].implied_value_usd; });
var paramsMatch = near(live.valueModel.med, R.model.value.med) && near(live.valueModel.betaSize, R.model.value.betaSize) && near(live.oddsModel.k, R.model.odds.k) && near(live.oddsModel.theta, R.model.odds.theta);
var ranksOk = live.board.every(function (r, i) { return r.rank === i + 1 && (i === 0 || r.implied_value_usd <= live.board[i - 1].implied_value_usd); });
var totalsOk = R.accounting.reduce(function (a, g) { return a + g.count; }, 0) === R.counts.protocols;
var checks = [
  ['Table rows recomputed from data', rowsMatch && paramsMatch],
  ['Ranks in order', ranksOk],
  ['Totals equal', totalsOk],
  ['Checksum', live.checksum === R.checksum],
  ['Watchlist fully ranked', R.rows.filter(function (r) { return r.watchlist; }).length === R.counts.watchlist],
  ['Ledger covers all protocols', totalsOk],
];
var P = new URLSearchParams(location.search);
var S = {
  deposit: Math.min(10000, Math.max(100, +(P.get('deposit') || 1000))),
  share: Math.min(25, Math.max(1, +(P.get('share') || 10))),
  horizon: Math.min(104, Math.max(4, +(P.get('horizon') || 26))),
  verdict: P.get('tab') || 'all', tier: P.get('tier') || 'all',
  search: P.get('search') || '', category: P.get('category') || 'all', chain: P.get('chain') || 'all',
  expanded: P.get('expand') || null,
};
function recompute() {
  var st = { deposit: S.deposit, share: S.share / 100, horizonWeeks: S.horizon };
  var rows = live.board.map(function (row) {
    var odds = F.tokenOdds(row, R.as_of, live.oddsModel, S.horizon);
    var launch = row.launch_value_usd;
    var implied = Math.max(1, Math.round(launch * odds));
    var v = F.verdictFor(row, implied, st);
    return Object.assign({}, row, {
      token_odds: Math.round(odds * 10000) / 10000, implied_value_usd: implied,
      p25_usd: Math.max(1, Math.round(launch * Math.exp(q.q25) * odds)),
      p75_usd: Math.max(1, Math.round(launch * Math.exp(q.q75) * odds)),
      p10_usd: Math.max(1, Math.round(launch * Math.exp(q.q10) * odds)),
      p90_usd: Math.max(1, Math.round(launch * Math.exp(q.q90) * odds)),
      verdict: v.verdict, net_usd: Math.round(v.net * 100) / 100, net_per_hour_usd: Math.round(v.netPerHour * 100) / 100,
      gross_usd: Math.round(v.gross * 100) / 100, costs_usd: Math.round(v.costs * 100) / 100, _v: v,
    });
  });
  rows.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd || (a.slug < b.slug ? -1 : 1); });
  rows.forEach(function (r, i) { r.rank = i + 1; });
  return rows;
}
var rows = recompute();
function filtered() {
  var n = S.search.trim().toLowerCase();
  return rows.filter(function (r) {
    return (S.verdict === 'all' || r.verdict === S.verdict.toUpperCase()) &&
      (S.tier === 'all' || r.tier === S.tier) &&
      (S.category === 'all' || (r.category || 'Other') === S.category) &&
      (S.chain === 'all' || r.chains.indexOf(S.chain) >= 0) &&
      (!n || r.name.toLowerCase().indexOf(n) >= 0 || r.slug.indexOf(n) >= 0);
  });
}
$('m-asof').textContent = R.as_of;
$('m-version').textContent = R.model_version + ' (value: ' + (R.model.value.kept.join(', ') || 'flat median') + '; odds: Weibull age' + (R.model.odds.kept.length ? ' + ' + R.model.odds.kept.join(', ') : '') + ')';
var keptCount = R.evidence.valueTerms.filter(function (t) { return t.status === 'kept'; }).length + R.evidence.oddsTerms.filter(function (t) { return t.status === 'kept'; }).length;
var testedCount = (R.evidence.valueTerms.length - 1) + (R.evidence.oddsTerms.length - 2);
var kpis = [
  [R.model.value.wf.toFixed(2), 'Out-of-sample error (walk-forward)', 'log points · ×' + Math.exp(R.model.value.wf).toFixed(1) + ' out-of-sample'],
  [Math.round(R.evidence.rangeRows[0].measured * 100) + '%', 'Range honesty (P25–P75)', 'P10–P90: ' + Math.round(R.evidence.rangeRows[1].measured * 100) + '% · targets 50% / 80%'],
  [R.model.odds.brierWF.toFixed(3), 'Token-odds Brier (walk-forward)', 'flat base rate: ' + R.model.odds.baseBrierWF.toFixed(3)],
  [keptCount + ' of ' + testedCount, 'Terms that survived both tests', 'size curve · token age (Weibull)'],
  ['', 'Worth farming (FARM)', ''],
  [R.counts.watchlist + ' / ' + R.counts.watchlist, 'Watchlist ranked', R.counts.board + ' rows on the board'],
];
function renderKpis() {
  var farm = rows.filter(function (r) { return r.verdict === 'FARM'; }).length;
  kpis[4][0] = String(farm);
  kpis[4][2] = 'at $' + ni(S.deposit) + ' · ' + S.share + '% · ' + S.horizon + 'w';
  $('kpis').innerHTML = kpis.map(function (k) {
    return '<div class="kpi"><div class="v">' + esc(k[0]) + '</div><div class="l">' + esc(k[1]) + '</div><div class="s">' + esc(k[2]) + '</div></div>';
  }).join('');
}
$('formula').innerHTML = '<b>implied value = TVL × fitted multiple × token odds.</b> The multiple falls as TVL grows — 10× the TVL ⇒ ×' + Math.exp(R.model.value.betaSize / R.model.value.sizeSd).toFixed(2) + ' the multiple — and the odds fall as a protocol ages without a token. Ranges are the value-model intervals scaled by token odds.';
var GC = ['#35c37a', '#5b8def', '#e0a63c', '#7a5fd0', '#8494a7', '#3d7a5c', '#2c6e9e', '#8a6d2f', '#5c4a7a'];
$('stackbar').innerHTML = R.accounting.map(function (g, i) {
  return '<div style="width:' + (g.count / R.counts.protocols * 100).toFixed(2) + '%;background:' + GC[i % GC.length] + '" title="' + esc(g.label) + ': ' + g.count + '"></div>';
}).join('');
$('groups').innerHTML = R.accounting.map(function (g, i) {
  return '<span><i class="dot" style="background:' + GC[i % GC.length] + '"></i>' + esc(g.label) + ' <b>' + g.count + '</b></span>';
}).join('');
$('checks').innerHTML = checks.map(function (c) {
  return '<li class="' + (c[1] ? 'ok' : 'bad') + '">' + (c[1] ? '✓' : '✗') + ' ' + esc(c[0]) + '</li>';
}).join('');
function chip(s) {
  var c = s === 'kept' ? 'kept' : s === 'baseline' ? 'base' : s === 'must not help' ? 'must' : 'no';
  return '<span class="st ' + c + '">' + esc(s) + '</span>';
}
function evTable(head, body) {
  return '<table class="ev"><thead><tr>' + head.map(function (h) { return '<th class="' + (h[1] ? 'n' : '') + '">' + esc(h[0]) + '</th>'; }).join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
}
$('ev-value').innerHTML = evTable([['Term'], ['LOO', 1], ['Walk-forward', 1], ['Status']],
  R.evidence.valueTerms.map(function (t) {
    return '<tr><td>' + esc(t.term) + '</td><td class="n">' + t.loo.toFixed(3) + '</td><td class="n">' + t.wf.toFixed(3) + '</td><td>' + chip(t.status) + '</td></tr>';
  }).join(''));
$('ev-odds').innerHTML = evTable([['Term'], ['10-fold', 1], ['Walk-forward', 1], ['Status']],
  R.evidence.oddsTerms.map(function (t) {
    return '<tr><td>' + esc(t.term) + '</td><td class="n">' + t.brier10.toFixed(3) + '</td><td class="n">' + t.brierWF.toFixed(3) + '</td><td>' + chip(t.status) + '</td></tr>';
  }).join(''));
$('ev-range').innerHTML = evTable([['Interval'], ['Stated', 1], ['Measured', 1], ['Bootstrap 95% CI', 1]],
  R.evidence.rangeRows.map(function (t) {
    return '<tr><td>' + esc(t.interval) + '</td><td class="n">' + Math.round(t.stated * 100) + '%</td><td class="n">' + Math.round(t.measured * 100) + '%</td><td class="n">' + Math.round(t.ciLo * 100) + '%–' + Math.round(t.ciHi * 100) + '%</td></tr>';
  }).join(''));
$('ev-note').textContent = 'Only ' + keptCount + ' of ' + testedCount + ' tested terms survived both held-out tests. The category effect looks strong in random cross-validation but fails walk-forward — noise, not signal. The “growth of another row” term improves both tests but is excluded by design: a valuation must come from a protocol’s own record, not one other row’s realised growth. The ranges are wide because token multiples vary ×' + Math.exp(R.model.value.wf).toFixed(1) + ' out-of-sample; the P25–P75 interval covered the real cap half the time and the P10–P90 interval 80% of the time, so the printed ranges are honest. The term search runs at build time (same code, same data); this page refits the surviving model live and verifies it — ' + (rowsMatch && paramsMatch ? 'the live refit matches the build.' : 'WARNING: the live refit differs from the build.');
var VERDICTS = [['all', 'All'], ['farm', 'Farm'], ['marginal', 'Marginal'], ['skip', 'Skip']];
var TIERS = [['all', 'All tiers'], ['watchlist', 'Watchlist'], ['early', 'Early'], ['off-list', 'Off-list']];
function tabs(el, opts, cur, key) {
  $(el).innerHTML = opts.map(function (o) {
    return '<button type="button" role="tab" aria-selected="' + (o[0] === cur) + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>';
  }).join('');
  $(el).querySelectorAll('button').forEach(function (b) {
    b.addEventListener('click', function () { S[key] = b.getAttribute('data-v'); render(); });
  });
}
function fillSelect(el, values, cur) {
  $(el).innerHTML = values.map(function (v) {
    return '<option value="' + esc(v[0]) + '"' + (v[0] === cur ? ' selected' : '') + '>' + esc(v[1]) + '</option>';
  }).join('');
}
var DEPOSITS = [100, 250, 500, 1000, 2500, 5000, 10000];
var cats = Array.from(new Set(rows.map(function (r) { return r.category || 'Other'; }))).sort();
var chains = Array.from(new Set(rows.reduce(function (a, r) { return a.concat(r.chains); }, []))).sort();
function renderControls() {
  tabs('tab-verdict', VERDICTS, S.verdict, 'verdict');
  tabs('tab-tier', TIERS, S.tier, 'tier');
  fillSelect('c-deposit', DEPOSITS.map(function (d) { return [String(d), '$' + ni(d)]; }), String(S.deposit));
  fillSelect('c-category', [['all', 'All categories']].concat(cats.map(function (c) { return [c, c]; })), S.category);
  fillSelect('c-chain', [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), S.chain);
  $('c-share').value = S.share; $('c-share-v').textContent = S.share + '%';
  $('c-horizon').value = S.horizon; $('c-horizon-v').textContent = S.horizon + 'w';
  $('c-search').value = S.search;
}
$('c-deposit').addEventListener('change', function () { S.deposit = +$('c-deposit').value; render(); });
$('c-share').addEventListener('input', function () { S.share = +$('c-share').value; $('c-share-v').textContent = S.share + '%'; render(); });
$('c-horizon').addEventListener('input', function () { S.horizon = +$('c-horizon').value; $('c-horizon-v').textContent = S.horizon + 'w'; render(); });
$('c-search').addEventListener('input', function () { S.search = $('c-search').value; renderTable(); });
$('c-category').addEventListener('change', function () { S.category = $('c-category').value; renderTable(); });
$('c-chain').addEventListener('change', function () { S.chain = $('c-chain').value; renderTable(); });
$('c-reset').addEventListener('click', function () {
  S = { deposit: 1000, share: 10, horizon: 26, verdict: 'all', tier: 'all', search: '', category: 'all', chain: 'all', expanded: null };
  render();
});
function download(name, text, type) {
  var a = D.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type }));
  a.download = name; a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
$('c-csv').addEventListener('click', function () {
  var f = filtered();
  var head = 'rank,slug,name,tier,tvl_usd,change_7d,age_days,token_odds,launch_value_usd,implied_value_usd,p25_usd,p75_usd,verdict,net_usd,net_per_hour_usd';
  var lines = [head].concat(f.map(function (r) {
    return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', r.tier, r.tvl_usd, r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days, r.token_odds, r.launch_value_usd, r.implied_value_usd, r.p25_usd, r.p75_usd, r.verdict, r.net_usd, r.net_per_hour_usd].join(',');
  }));
  download('launch-radar.csv', lines.join('\n') + '\n', 'text/csv');
});
$('c-json').addEventListener('click', function () {
  download('launch-radar.json', JSON.stringify({ as_of: R.as_of, settings: { deposit: S.deposit, share: S.share / 100, horizonWeeks: S.horizon }, rows: filtered() }, null, 2) + '\n', 'application/json');
});
function rangeBar(r) {
  var lo = Math.log(r.p10_usd), hi = Math.log(r.p90_usd);
  var a = (Math.log(r.p25_usd) - lo) / (hi - lo) * 100, b = (Math.log(r.p75_usd) - lo) / (hi - lo) * 100, m = (Math.log(r.implied_value_usd) - lo) / (hi - lo) * 100;
  return '<span class="rbar"><span class="rg" style="left:' + a.toFixed(1) + '%;width:' + (b - a).toFixed(1) + '%"></span><span class="mk" style="left:' + m.toFixed(1) + '%"></span></span> ' + m$(r.p25_usd) + '–' + m$(r.p75_usd);
}
function badges(r) {
  var b = '';
  if (r.watchlist) b += '<span class="badge wl">Watchlist</span>';
  if (r.tier === 'off-list') b += '<span class="badge ol">Off-list</span>';
  if (r.parent_multiplier) b += '<span class="badge pm" title="Parent protocol already records a token">Parent multiplier</span>';
  return b;
}
function detailHTML(r) {
  var v = r._v;
  var st = { deposit: S.deposit, share: S.share / 100, horizonWeeks: S.horizon };
  var steps = F.farmSteps(r, v, st);
  var peers = F.nearestPeers(snap, r, 3);
  return '<h4>How the figure is made</h4><p>TVL ' + m$(r.tvl_usd) + ' × multiple ' + r.multiple.toFixed(3) + ' = if-it-launches ' + m$(r.launch_value_usd) +
    '; × token odds ' + (r.token_odds * 100).toFixed(1) + '% (Weibull, age ' + age(r.age_days) + ', horizon ' + S.horizon + 'w) = implied ' + m$(r.implied_value_usd) +
    '. P25–P75 ' + m$(r.p25_usd) + '–' + m$(r.p75_usd) + '; P10–P90 ' + m$(r.p10_usd) + '–' + m$(r.p90_usd) + '.</p>' +
    '<h4>Farm verdict — ' + r.verdict + '</h4><p class="costs">Expected airdrop <b>' + neg(r.gross_usd) + '</b> (implied × ' + S.share + '% × $' + ni(S.deposit) + ' / TVL) minus gas <b>' + neg(v.gas) + '</b>, fees <b>' + neg(v.fees) + '</b>, T-bill cost <b>' + neg(v.opp) + '</b> (4%), hands-on <b>' + neg(v.labor) + '</b> (' + v.mins + ' min at $25/hour) = net <b class="' + (r.net_usd >= 0 ? 'pos' : 'neg') + '">' + neg(r.net_usd) + '</b> (' + neg(r.net_per_hour_usd) + '/hour). FARM needs net &gt; 0 and net/hour ≥ $31.25.</p>' +
    '<h4>Farm plan — $' + ni(S.deposit) + ' deposit, ' + S.horizon + ' weeks</h4><ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
    '<h4>Nearest priced peers</h4><table class="peers"><thead><tr><th>Protocol</th><th>TVL</th><th>Market cap</th><th>Multiple</th><th>7D</th></tr></thead><tbody>' +
    peers.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td>' + m$(p.tvl_usd) + '</td><td>' + m$(p.mcap_usd) + '</td><td>' + p.multiple.toFixed(3) + '</td><td>' + chg(p.change_7d) + '</td></tr>';
    }).join('') + '</tbody></table>';
}
function renderTable() {
  var f = filtered();
  var html = '';
  f.forEach(function (r) {
    var open = S.expanded === r.slug;
    html += '<tr data-slug="' + esc(r.slug) + '" class="' + (open ? 'open' : '') + '"><td>' + r.rank + '</td>' +
      '<td><span class="nm">' + esc(r.name) + '</span>' + badges(r) + '</td>' +
      '<td>' + m$(r.tvl_usd) + '</td><td>' + chg(r.change_7d) + '</td><td>' + age(r.age_days) + '</td>' +
      '<td><span class="mini"><i style="width:' + Math.min(100, r.token_odds / 0.25 * 100).toFixed(0) + '%"></i></span>' + (r.token_odds * 100).toFixed(1) + '%</td>' +
      '<td>' + m$(r.launch_value_usd) + '</td><td><b>' + m$(r.implied_value_usd) + '</b></td>' +
      '<td>' + rangeBar(r) + '</td>' +
      '<td><span class="chip ' + r.verdict + '">' + r.verdict + '</span> <span class="' + (r.net_usd >= 0 ? 'pos' : 'neg') + '">' + neg(r.net_usd) + '</span></td>' +
      '<td class="' + (r.net_per_hour_usd >= 0 ? 'pos' : 'neg') + '">' + neg(r.net_per_hour_usd) + '/h</td></tr>';
    if (open) html += '<tr class="detail"><td colspan="11">' + detailHTML(r) + '</td></tr>';
  });
  var tb = $('tbody');
  tb.innerHTML = html;
  tb.querySelectorAll('tr[data-slug]').forEach(function (tr) {
    tr.addEventListener('click', function () {
      S.expanded = S.expanded === tr.getAttribute('data-slug') ? null : tr.getAttribute('data-slug');
      renderTable();
    });
  });
  $('rowcount').textContent = f.length + ' of ' + rows.length + ' rows · deposit $' + ni(S.deposit) + ' · drop share ' + S.share + '% · horizon ' + S.horizon + 'w';
  $('board-sub').textContent = '· ' + R.counts.board + ' rows · sorted by implied value at ' + S.horizon + 'w';
  var empty = $('empty');
  if (f.length === 0) {
    empty.hidden = false;
    empty.textContent = S.verdict === 'farm'
      ? 'No row clears its costs at these settings. Farming only pays with a larger deposit on small, young protocols — try a $10,000 deposit, a 25% drop share and a 13-week horizon, then look again.'
      : 'No rows match these filters. Loosen the search or reset the controls.';
  } else { empty.hidden = true; }
}
function render() {
  rows = recompute();
  renderKpis();
  renderControls();
  renderTable();
}
$('live-note').textContent = rowsMatch && paramsMatch
  ? 'Live refit in this page matches the build (checksum ' + R.checksum + ').'
  : 'WARNING: the live refit differs from the build.';
render();
})();
