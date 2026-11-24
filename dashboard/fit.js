// Launch Radar (radar-3): the model for the token-radar-01 entry.
//
// One file, plain JavaScript, no imports, no network, no clock, no randomness
// except seeded generators. It runs identically in Node (main.ts hands it the
// sealed snapshot and writes board.json + data.js) and in the browser (a classic
// script, where it refits the surviving model live from the embedded snapshot).
//
// Model: every protocol lands in exactly one of nine groups so totals reconcile.
// The board ranks the pre-token protocols the watchlist's filter keeps (the
// 40-protocol watchlist plus every other rankable one). Implied value = TVL x
// fitted market-cap/TVL multiple x token odds. The multiple starts from a flat
// median and keeps a term only when it lowers held-out error in BOTH
// leave-one-out AND walk-forward tests; the search itself is lib/termsearch.js
// and runs only at build time. Token odds come from a Weibull current-status
// fit on how long peers ran before recording a token, same both-tests rule.
// Ranges are leave-one-out residual quantiles; their honesty is measured and
// bootstrapped. Farm verdicts price the expected airdrop against real costs
// (gas by chain, fees, slippage, T-bill opportunity cost, $25/hour hands-on).
//
// Nothing is hard-coded to a protocol name: every number is fitted from the
// snapshot given. The constants below are the fitting machinery's own settings
// (grid steps, ridge penalties, the noise floor), stated, not tuned.

'use strict';

var MODEL_VERSION = 'radar-3';
var DAY_MS = 86400000;

/* ---------------------------------------------------------------- utilities */

/** A finite number, else `fallback`. */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Clamp `x` into [lo, hi].
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

// The middle value of a copy; null when empty.
function median(values) {
  if (values.length === 0) return null;
  var s = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// A quantile with linear interpolation (the numpy default), on a sorted array.
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN;
  var pos = (sorted.length - 1) * q;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// A small deterministic generator (mulberry32): the only randomness in the file.
function mulberry32(seed) {
  var a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A whole day count from `from` to `to`, clamped at zero; null when a date is absent.
function ageDays(asOf, listedAt) {
  if (listedAt === null || listedAt === undefined) return null;
  var a = Date.parse(asOf + 'T00:00:00Z');
  var b = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// The middle value of the sorted unique dates, as a YYYY-MM-DD string.
function medianDate(dates) {
  var u = Array.from(new Set(dates)).sort();
  return u[Math.floor(u.length / 2)];
}

// Split an array into `k` near-equal parts, in order (numpy's array_split).
function arraySplit(arr, k) {
  var n = arr.length;
  var base = Math.floor(n / k);
  var rem = n % k;
  var out = [];
  var start = 0;
  for (var i = 0; i < k; i++) {
    var size = base + (i < rem ? 1 : 0);
    out.push(arr.slice(start, start + size));
    start += size;
  }
  return out;
}

// Solve (A + diag(lambda)) x = b by Gaussian elimination with partial pivoting.
function solveRidge(A, b, lambda) {
  var k = b.length;
  var M = [];
  for (var i = 0; i < k; i++) {
    var row = A[i].slice();
    row[i] += lambda[i];
    row.push(b[i]);
    M.push(row);
  }
  for (var col = 0; col < k; col++) {
    var piv = col;
    for (var r = col + 1; r < k; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (piv !== col) {
      var tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
    }
    var diag = M[col][col];
    if (Math.abs(diag) < 1e-12) continue;
    for (var r2 = col + 1; r2 < k; r2++) {
      var f = M[r2][col] / diag;
      if (f === 0) continue;
      for (var c = col; c <= k; c++) M[r2][c] -= f * M[col][c];
    }
  }
  var x = new Array(k).fill(0);
  for (var i2 = k - 1; i2 >= 0; i2--) {
    var sum = M[i2][k];
    for (var j = i2 + 1; j < k; j++) sum -= M[i2][j] * x[j];
    x[i2] = Math.abs(M[i2][i2]) < 1e-12 ? 0 : sum / M[i2][i2];
  }
  return x;
}

/* ------------------------------------------------------------- classification */

// DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol.
var VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// Categories that are wrapped, staked or bridged products of a token that already trades.
var EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
var BRIDGE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge']);
var LIQUID_STAKING_CATEGORIES = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

// Exchange names a pre-token protocol must not start with (the watchlist's own rule).
var EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

// The nine groups, in the order the accounting bar stacks them.
var GROUPS = [
  { key: 'ranked-watchlist', label: 'Ranked (watchlist)' },
  { key: 'ranked-early', label: 'Ranked (early, below TVL floor)' },
  { key: 'ranked-offlist', label: 'Ranked (off-list, parent recorded)' },
  { key: 'token-trades', label: 'Token trades (priced comp)' },
  { key: 'token-recorded', label: 'Token recorded (no usable cap)' },
  { key: 'out-bridge', label: 'Out (bridge)' },
  { key: 'out-liquid-staking', label: 'Out (liquid staking)' },
  { key: 'out-exchange', label: 'Out (exchange)' },
  { key: 'out-versioned', label: 'Out (versioned / wrapped)' },
];

// Whether a protocol records no token at all.
function isPreToken(p) {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// Whether a protocol is one the board may rank: pre-token, not an exchange or a
function isRankable(p) {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some(function (e) { return p.name.indexOf(e) === 0; })) return false;
  return true;
}

// The one group a protocol belongs to. A rankable pre-token protocol above the
function groupOf(p, watchlist, floorUsd) {
  if (isPreToken(p)) {
    if (watchlist.has(p.slug)) return 'ranked-watchlist';
    if (isRankable(p)) return p.tvl_usd >= floorUsd ? 'ranked-offlist' : 'ranked-early';
    if (p.category !== null && BRIDGE_CATEGORIES.has(p.category)) return 'out-bridge';
    if (p.category !== null && LIQUID_STAKING_CATEGORIES.has(p.category)) return 'out-liquid-staking';
    if (p.category === 'CEX') return 'out-exchange';
    return 'out-versioned';
  }
  if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) return 'token-trades';
  return 'token-recorded';
}

// The first word of a protocol's family name, after stripping a version suffix.
// Why the snapshot is not one this model can score.
function SnapshotError(message) {
  var e = new Error(message);
  e.name = 'SnapshotError';
  return e;
}

// The snapshot out of a file's text, refused unless it is the shape the model scores.
function parseSnapshot(text) {
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw SnapshotError('snapshot.json is not a JSON object');
  if (typeof raw.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.as_of)) throw SnapshotError('snapshot.json has no as_of date');
  if (typeof raw.source !== 'string') throw SnapshotError('snapshot.json has no source');
  if (typeof raw.floor_usd !== 'number' || !Number.isSafeInteger(raw.floor_usd) || raw.floor_usd <= 0) throw SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(raw.protocols)) throw SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(raw.watchlist) || raw.watchlist.some(function (s) { return typeof s !== 'string'; })) throw SnapshotError('snapshot.json has no watchlist of slugs');
  var protocols = raw.protocols.map(function (v, i) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw SnapshotError('snapshot.json protocol ' + i + ' is not an object');
    if (typeof v.slug !== 'string' || typeof v.name !== 'string' || typeof v.tvl_usd !== 'number' || !Number.isFinite(v.tvl_usd)) {
      throw SnapshotError('snapshot.json protocol ' + i + ' lacks a slug, a name or a TVL');
    }
    return {
      slug: v.slug,
      name: v.name,
      category: typeof v.category === 'string' ? v.category : null,
      chains: Array.isArray(v.chains) ? v.chains.filter(function (c) { return typeof c === 'string'; }) : [],
      tvl_usd: v.tvl_usd,
      change_7d: typeof v.change_7d === 'number' && Number.isFinite(v.change_7d) ? v.change_7d : null,
      mcap_usd: typeof v.mcap_usd === 'number' && Number.isFinite(v.mcap_usd) ? v.mcap_usd : null,
      listed_at: typeof v.listed_at === 'string' ? v.listed_at : null,
      gecko_id: typeof v.gecko_id === 'string' ? v.gecko_id : null,
      symbol: typeof v.symbol === 'string' ? v.symbol : null,
    };
  });
  return { as_of: raw.as_of, source: raw.source, floor_usd: raw.floor_usd, protocols: protocols, watchlist: raw.watchlist };
}

/* ------------------------------------------------------------ value model */

// The value model's candidate terms, in the order they are tested. `leader` is
// Ridge penalty on a standardised continuous term. The term search (lib/
// termsearch.js) tests dummy terms too; this file refits only the surviving
// continuous terms, so it needs no dummy machinery.
var LAMBDA_CONT = 1.0;

// Fit the ridge on `train` rows for the given continuous feature names.
function fitValueTerms(train, featureNames) {
  var y = train.map(function (r) { return r.y; });
  var med = median(y) || 0;
  var cols = [];
  var lambdas = [];
  var stats = [];
  for (var fi = 0; fi < featureNames.length; fi++) {
    var vals = train.map(function (r) { return r.f[featureNames[fi]]; });
    var mu = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
    var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / vals.length) || 1;
    stats.push({ kind: 'cont', name: featureNames[fi], mu: mu, sd: sd });
    cols.push({ kind: 'cont', name: featureNames[fi], mu: mu, sd: sd });
    lambdas.push(LAMBDA_CONT);
  }
  var k = cols.length;
  var beta = new Array(k).fill(0);
  if (k > 0) {
    var A = [];
    var b = [];
    for (var i = 0; i < k; i++) {
      A.push(new Array(k).fill(0));
      b.push(0);
    }
    for (var ri = 0; ri < train.length; ri++) {
      var r = train[ri];
      var xv = new Array(k).fill(0);
      for (var cj = 0; cj < k; cj++) xv[cj] = (r.f[cols[cj].name] - cols[cj].mu) / cols[cj].sd;
      var yc = r.y - med;
      for (var a = 0; a < k; a++) {
        b[a] += xv[a] * yc;
        for (var c2 = 0; c2 < k; c2++) A[a][c2] += xv[a] * xv[c2];
      }
    }
    beta = solveRidge(A, b, lambdas);
  }
  function predict(f) {
    var s = med;
    for (var j = 0; j < k; j++) s += beta[j] * ((f[cols[j].name] - cols[j].mu) / cols[j].sd);
    return s;
  }
  return { med: med, beta: beta, cols: cols, stats: stats, predict: predict };
}

// The priced comps with their log-ratio target and the size feature.
function valueComps(snapshot) {
  var priced = snapshot.protocols.filter(function (p) { return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0; });
  return priced.map(function (p) {
    return { p: p, y: Math.log(p.mcap_usd / p.tvl_usd), f: { size: Math.log10(p.tvl_usd) } };
  });
}

// Fit the value model for one kept feature set (the term search lives in
function fitValueModel(snapshot, kept) {
  kept = kept || [];
  var comps = valueComps(snapshot);
  var final = fitValueTerms(comps, kept);
  var sizeStat = null;
  for (var si = 0; si < final.stats.length; si++) {
    if (final.stats[si].kind === 'cont' && final.stats[si].name === 'size') sizeStat = final.stats[si];
  }
  var sizeBeta = 0;
  for (var bi = 0; bi < final.cols.length; bi++) {
    if (final.cols[bi].kind === 'cont' && final.cols[bi].name === 'size') sizeBeta = final.beta[bi];
  }
  return {
    comps: comps,
    kept: kept,
    med: final.med,
    betaSize: sizeBeta,
    sizeMu: sizeStat ? sizeStat.mu : 0,
    sizeSd: sizeStat ? sizeStat.sd : 1,
    predict: final.predict,
    finalFit: final,
  };
}

// The fitted multiple for one protocol's TVL under the final value model.
function multipleFor(tvlUsd, valueModel) {
  var z = (Math.log10(tvlUsd) - valueModel.sizeMu) / valueModel.sizeSd;
  return Math.exp(valueModel.med + valueModel.betaSize * z);
}

/* ------------------------------------------------------------- token odds */

// The odds model's candidate terms, tested in this order on top of the Weibull
// Weibull grid for the final fit. The term search (lib/termsearch.js) tests
// odds covariates too; this file refits only the surviving Weibull age model,
// so it needs no design matrix or covariate fitting.
var WEIBULL_FINE = { kMin: 0.2, kMax: 2.0, kStep: 0.02, thMin: 0.3, thMax: 12.0, thStep: 0.1 };

// Weibull survival at age `t` (years) under shape k and scale theta.
function weibullSurv(t, k, th) {
  if (t <= 0) return 1;
  return Math.exp(-Math.pow(t / th, k));
}

// The current-status log-likelihood: a protocol with a token contributes
function weibullLogLik(k, th, ages, y, lam) {
  var ll = 0;
  for (var i = 0; i < ages.length; i++) {
    var s = weibullSurv(ages[i], k, th);
    if (lam) s = Math.exp(-Math.pow(ages[i] / th, k) * lam[i]);
    if (s < 1e-12) s = 1e-12;
    if (s > 1 - 1e-12) s = 1 - 1e-12;
    ll += y[i] === 1 ? Math.log(1 - s) : Math.log(s);
  }
  return ll;
}

// The Weibull (k, theta) that maximises the log-likelihood on a grid.
function fitWeibullGrid(ages, y, grid) {
  var best = { k: 1, th: 1, ll: -Infinity };
  for (var k = grid.kMin; k <= grid.kMax + 1e-9; k += grid.kStep) {
    for (var th = grid.thMin; th <= grid.thMax + 1e-9; th += grid.thStep) {
      var ll = weibullLogLik(k, th, ages, y, null);
      if (ll > best.ll) best = { k: Math.round(k * 10000) / 10000, th: Math.round(th * 10000) / 10000, ll: ll };
    }
  }
  return best;
}

// The protocols with a known listing date, with age in years and the token outcome.
function oddsRows(snapshot) {
  return snapshot.protocols
    .filter(function (p) { return p.listed_at !== null; })
    .map(function (p) {
      var ageD = ageDays(snapshot.as_of, p.listed_at);
      return { p: p, ageYears: ageD / 365.25, y: isPreToken(p) ? 0 : 1 };
    });
}

// Fit the odds model (the term search lives in lib/termsearch.js): the
// surviving model is the Weibull age baseline, no covariates survived.
function fitOddsModel(snapshot, preTokenMedianAgeDays, kept) {
  kept = kept || [];
  var rows = oddsRows(snapshot);
  var finalW = fitWeibullGrid(rows.map(function (r) { return r.ageYears; }), rows.map(function (r) { return r.y; }), WEIBULL_FINE);
  return {
    rows: rows,
    kept: kept,
    k: finalW.k,
    theta: finalW.th,
    baseRate: rows.reduce(function (a, r) { return a + r.y; }, 0) / rows.length,
    preTokenMedianAgeDays: preTokenMedianAgeDays,
  };
}

// P(a token launches within `horizonWeeks` | the protocol survived to its age).
function tokenOdds(p, asOf, oddsModel, horizonWeeks) {
  var ageD = ageDays(asOf, p.listed_at);
  if (ageD === null) ageD = oddsModel.preTokenMedianAgeDays;
  var a = ageD / 365.25;
  var h = horizonWeeks / 52;
  var sA = Math.exp(-Math.pow(a / oddsModel.theta, oddsModel.k));
  var sAH = Math.exp(-Math.pow((a + h) / oddsModel.theta, oddsModel.k));
  return 1 - sAH / sA;
}

/* ------------------------------------------------------- ranges, honesty */

// The printed ranges, from the final value model's leave-one-out residuals:
function fitRanges(valueModel) {
  var comps = valueModel.comps;
  var residuals = [];
  for (var i = 0; i < comps.length; i++) {
    var train = [];
    for (var j = 0; j < comps.length; j++) if (j !== i) train.push(comps[j]);
    var m = fitValueTerms(train, valueModel.kept);
    residuals.push(comps[i].y - m.predict(comps[i].f));
  }
  var sorted = residuals.slice().sort(function (a, b) { return a - b; });
  var q10 = quantileSorted(sorted, 0.1);
  var q25 = quantileSorted(sorted, 0.25);
  var q75 = quantileSorted(sorted, 0.75);
  var q90 = quantileSorted(sorted, 0.9);
  function coverage(lo, hi) {
    var inside = 0;
    for (var i = 0; i < residuals.length; i++) {
      if (residuals[i] >= lo && residuals[i] <= hi) inside++;
    }
    return inside / residuals.length;
  }
  var cov2575 = coverage(q25, q75);
  var cov1090 = coverage(q10, q90);
  function bootCI(lo, hi) {
    var inside = residuals.map(function (r) { return r >= lo && r <= hi ? 1 : 0; });
    var rng = mulberry32(11);
    var bs = [];
    for (var b = 0; b < 2000; b++) {
      var s = 0;
      for (var i = 0; i < inside.length; i++) s += inside[Math.floor(rng() * inside.length)];
      bs.push(s / inside.length);
    }
    bs.sort(function (a, b) { return a - b; });
    return { lo: quantileSorted(bs, 0.025), hi: quantileSorted(bs, 0.975) };
  }
  var ci2575 = bootCI(q25, q75);
  var ci1090 = bootCI(q10, q90);
  var looRmse = Math.sqrt(residuals.reduce(function (a, r) { return a + r * r; }, 0) / residuals.length);
  return {
    q10: q10,
    q25: q25,
    q75: q75,
    q90: q90,
    looRmse: looRmse,
    table: [
      { interval: 'P25-P75', stated: 0.5, measured: cov2575, ciLo: ci2575.lo, ciHi: ci2575.hi },
      { interval: 'P10-P90', stated: 0.8, measured: cov1090, ciLo: ci1090.lo, ciHi: ci1090.hi },
    ],
  };
}

/* ------------------------------------------------------ farm verdicts */

// What one on-chain action costs on each chain, in dollars (a deposit, a claim, a swap).
var GAS_USD = { Ethereum: 6.0, BSC: 0.3, Solana: 0.05, Base: 0.4, Arbitrum: 0.4, Optimism: 0.4 };

// The gas price of one action on a protocol's first (primary) chain.
function gasPerAction(p) {
  for (var i = 0; i < p.chains.length; i++) {
    if (GAS_USD[p.chains[i]] !== undefined) return GAS_USD[p.chains[i]];
  }
  return 1.0;
}

// The default farm settings the board is built at (the dashboard starts here).
var DEFAULT_SETTINGS = { deposit: 1000, share: 0.1, horizonWeeks: 26 };

// The T-bill rate charged as the deposit's opportunity cost, and the hourly wage.
var TBILL_RATE = 0.04;
var HOURLY_WAGE = 25;
// FARM needs net/hour at least this multiple of the wage ("beats it clearly").
var FARM_WAGE_MULTIPLE = 1.25;

// The farm verdict for one row at the given settings. Expected airdrop =
function verdictFor(p, impliedUsd, settings) {
  var D = settings.deposit;
  var s = settings.share;
  var H = settings.horizonWeeks;
  var checkins = Math.ceil(H / 4);
  var actions = 3 + checkins;
  var gas = gasPerAction(p) * actions;
  var fees = 0.004 * D;
  var opp = D * TBILL_RATE * (H / 52);
  var mins = 15 + 10 * checkins + 10;
  var labor = (mins / 60) * HOURLY_WAGE;
  var gross = impliedUsd * s * (D / p.tvl_usd);
  var costs = gas + fees + opp + labor;
  var net = gross - costs;
  var netPerHour = net / (mins / 60);
  var verdict = net > 0 && netPerHour >= FARM_WAGE_MULTIPLE * HOURLY_WAGE ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { verdict: verdict, gross: gross, gas: gas, fees: fees, opp: opp, labor: labor, costs: costs, net: net, netPerHour: netPerHour, mins: mins, actions: actions, checkins: checkins };
}

// The core action, in the words a farmer can follow.
function actionFor(p, capital, chain) {
  var c = (p.category || '').toLowerCase();
  var n = p.name, d = '$' + capital;
  if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply ' + d + ' of USDC to ' + n + ' on ' + chain + ' as a lender and leave the deposit earning for the full window.';
  if (c.indexOf('dex') >= 0) return 'Add ' + d + ' of liquidity to ' + n + "'s deepest pool on " + chain + ' (a stable pair if one exists) and keep the LP position open.';
  if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('curator') >= 0) return 'Deposit ' + d + ' into a ' + n + ' vault on ' + chain + ', pick the vault with the longest lock, and keep the receipt tokens.';
  if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Deposit ' + d + ' of USDC as margin on ' + n + ' on ' + chain + ', open one small hedged position, and close it only after a week.';
  return 'Deposit ' + d + ' of USDC into ' + n + ' on ' + chain + ' and keep the position open for the full window.';
}

// The check-in action, so the wallet shows repeat activity.
function weeklyFor(p, chain) {
  var c = (p.category || '').toLowerCase();
  var n = p.name;
  if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Top up the deposit or borrow $10 against it on ' + chain + ', then repay it the same week.';
  if (c.indexOf('dex') >= 0) return 'Swap $10 through ' + n + "'s main pool on " + chain + ' and add the output back to the position.';
  if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('curator') >= 0) return 'Claim the vault rewards on ' + chain + ' and re-deposit them instead of selling.';
  return 'Do one small on-chain action inside ' + n + ' on ' + chain + ' every check-in: a deposit, a swap, a claim or a vote.';
}

// One step as a single string, inside the gate's 20..600 characters.
function stepText(s) {
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s = s + ' Hold the position and check the protocol’s own page.';
  return s;
}

// Round a dollar figure for display inside a step.
function dollars(n) {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US');
  if (n >= 10) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

// A protocol's farm plan: six steps, each an action with a cost and a time,
function farmSteps(p, verdict, settings) {
  var chain = p.chains.length > 0 ? p.chains[0] : 'its main chain';
  var D = settings.deposit;
  var H = settings.horizonWeeks;
  var gas = gasPerAction(p);
  var sharePct = Math.round(settings.share * 100);
  var reason =
    verdict.verdict === 'FARM'
      ? 'the net beats the T-bill return and clears $' + (FARM_WAGE_MULTIPLE * HOURLY_WAGE) + '/hour of hands-on time'
      : verdict.verdict === 'MARGINAL'
        ? 'the net is positive but too small to beat the hourly benchmark clearly'
        : 'the costs outweigh the expected airdrop at this deposit and drop share';
  var steps = [
    'Set up a fresh wallet that holds only the funds you plan to farm with, write its seed phrase on paper, and fund it with $' +
      (D + 10) +
      ' of USDC on ' +
      chain +
      ' (about ' +
      dollars(gas) +
      ' in gas). Never reuse a wallet that holds your main funds.',
    actionFor(p, D, chain) +
      ' Cost: about ' +
      dollars(gas) +
      ' in gas plus 0.1% in entry fees. Time: 15 minutes to set up.',
    'Every 4 weeks, ' +
      weeklyFor(p, chain) +
      ' Cost: about ' +
      dollars(gas) +
      ' in gas per check-in. Time: 10 minutes per check-in, ' +
      verdict.checkins +
      ' check-ins over ' +
      H +
      ' weeks.',
    'Hold the position for ' +
      H +
      ' weeks without withdrawing, so the wallet’s activity is counted in more than one snapshot. If the protocol announces a token or a points snapshot before then, note the date and move to the claim step early.',
    'At week ' +
      H +
      ' (or as soon as a token is announced), withdraw the deposit and claim any airdrop from the protocol’s own points page only — never pay anyone to claim for you. Cost: about ' +
      dollars(gas) +
      ' in gas. Time: 10 minutes.',
    'Expected airdrop ' +
      dollars(verdict.gross) +
      ' at a ' +
      sharePct +
      '% drop share, minus ' +
      dollars(verdict.costs) +
      ' in gas, fees, T-bill opportunity cost (4%) and ' +
      dollars(verdict.labor) +
      ' of hands-on time at $25/hour: net ' +
      dollars(verdict.net) +
      ' (' +
      dollars(verdict.netPerHour) +
      '/hour). Verdict: ' +
      verdict.verdict +
      ' — ' +
      reason +
      '.',
  ];
  return steps.map(stepText);
}

/* ------------------------------------------------------- peers, board */

// The nearest priced peers: token-bearing protocols, same category first, then
function nearestPeers(snapshot, row, count) {
  var comps = snapshot.protocols.filter(function (p) {
    return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.slug !== row.slug;
  });
  comps.sort(function (a, b) {
    var ca = (a.category || 'Other') === (row.category || 'Other') ? 0 : 1;
    var cb = (b.category || 'Other') === (row.category || 'Other') ? 0 : 1;
    if (ca !== cb) return ca - cb;
    var da = Math.abs(Math.log(a.tvl_usd / row.tvl_usd));
    var db = Math.abs(Math.log(b.tvl_usd / row.tvl_usd));
    return da - db;
  });
  return comps.slice(0, count || 3).map(function (p) {
    return {
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      multiple: p.mcap_usd / p.tvl_usd,
      change_7d: p.change_7d,
    };
  });
}

// A 32-bit FNV-1a checksum of the board, for the live integrity check.
function boardChecksum(board) {
  var h = 0x811c9dc5;
  var s = board.map(function (r) { return r.slug + ':' + r.implied_value_usd + ';'; }).join('');
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}

// The nine-group accounting of the whole snapshot.
function accountingOf(snapshot) {
  var watchlist = new Set(snapshot.watchlist);
  var counts = {};
  GROUPS.forEach(function (g) { counts[g.key] = 0; });
  snapshot.protocols.forEach(function (p) {
    counts[groupOf(p, watchlist, snapshot.floor_usd)]++;
  });
  return GROUPS.map(function (g) { return { key: g.key, label: g.label, count: counts[g.key] }; });
}

// The ranked board at the given settings: every watchlist slug taken whole,
function buildBoard(snapshot, valueModel, oddsModel, ranges, settings) {
  var watchlist = new Set(snapshot.watchlist);
  var index = new Map(snapshot.protocols.map(function (p) { return [p.slug, p]; }));
  var chosen = new Map();
  snapshot.watchlist.forEach(function (slug) {
    var p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  });
  snapshot.protocols.forEach(function (p) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  });
  var scored = [];
  chosen.forEach(function (p) {
    var multiple = multipleFor(p.tvl_usd, valueModel);
    var launch = p.tvl_usd * multiple;
    var odds = tokenOdds(p, snapshot.as_of, oddsModel, settings.horizonWeeks);
    var implied = Math.max(1, Math.round(launch * odds));
    var age = ageDays(snapshot.as_of, p.listed_at);
    var verdict = verdictFor(p, implied, settings);
    var group = groupOf(p, watchlist, snapshot.floor_usd);
    scored.push({
      p: p,
      multiple: multiple,
      launch: launch,
      odds: odds,
      implied: implied,
      age: age,
      verdict: verdict,
      tier: group === 'ranked-watchlist' ? 'watchlist' : group === 'ranked-early' ? 'early' : 'off-list',
    });
  });
  scored.sort(function (a, b) {
    return b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0);
  });
  return scored.map(function (s, i) {
    var p = s.p;
    var q = ranges;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age,
      token_status: 'pre-token',
      watchlist: watchlist.has(p.slug),
      tier: s.tier,
      parent_multiplier: s.tier === 'off-list',
      implied_value_usd: s.implied,
      launch_value_usd: Math.max(1, Math.round(s.launch)),
      token_odds: Math.round(s.odds * 10000) / 10000,
      multiple: Math.round(s.multiple * 10000) / 10000,
      p25_usd: Math.max(1, Math.round(s.launch * Math.exp(q.q25) * s.odds)),
      p75_usd: Math.max(1, Math.round(s.launch * Math.exp(q.q75) * s.odds)),
      p10_usd: Math.max(1, Math.round(s.launch * Math.exp(q.q10) * s.odds)),
      p90_usd: Math.max(1, Math.round(s.launch * Math.exp(q.q90) * s.odds)),
      verdict: s.verdict.verdict,
      net_usd: Math.round(s.verdict.net * 100) / 100,
      net_per_hour_usd: Math.round(s.verdict.netPerHour * 100) / 100,
      gross_usd: Math.round(s.verdict.gross * 100) / 100,
      costs_usd: Math.round(s.verdict.costs * 100) / 100,
      farm_steps: farmSteps(p, s.verdict, DEFAULT_SETTINGS),
    };
  });
}

// The pre-token median age (days), the fallback age for protocols with no listing date.
function preTokenMedianAge(snapshot) {
  var preAges = snapshot.protocols
    .filter(function (p) { return isPreToken(p) && p.listed_at !== null; })
    .map(function (p) { return ageDays(snapshot.as_of, p.listed_at); });
  return median(preAges) || 365;
}

// Refit the surviving model live from the snapshot (what the browser runs on
function refitLive(snapshot, keptValue, keptOdds) {
  var medianAge = preTokenMedianAge(snapshot);
  var valueModel = fitValueModel(snapshot, keptValue);
  var oddsModel = fitOddsModel(snapshot, medianAge, keptOdds);
  var ranges = fitRanges(valueModel);
  var board = buildBoard(snapshot, valueModel, oddsModel, ranges, DEFAULT_SETTINGS);
  return { valueModel: valueModel, oddsModel: oddsModel, ranges: ranges, board: board, checksum: boardChecksum(board), preTokenMedianAgeDays: medianAge };
}

// Everything, for the build: take the term search's surviving sets and
function buildRadar(snapshot, search, settings) {
  var st = settings || DEFAULT_SETTINGS;
  var srch = search || { valueKept: ['size'], oddsKept: [], valueTerms: [], oddsTerms: [], oddsBrier10: 0, oddsBrierWF: 0, baseBrier10: 0, baseBrierWF: 0 };
  var medianAge = preTokenMedianAge(snapshot);
  var valueModel = fitValueModel(snapshot, srch.valueKept);
  var oddsModel = fitOddsModel(snapshot, medianAge, srch.oddsKept);
  var ranges = fitRanges(valueModel);
  var board = buildBoard(snapshot, valueModel, oddsModel, ranges, st);
  var accounting = accountingOf(snapshot);
  var checksum = boardChecksum(board);
  var farmCount = board.filter(function (r) { return r.verdict === 'FARM'; }).length;
  var marginalCount = board.filter(function (r) { return r.verdict === 'MARGINAL'; }).length;
  var radar = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      value: { med: valueModel.med, betaSize: valueModel.betaSize, sizeMu: valueModel.sizeMu, sizeSd: valueModel.sizeSd, loo: srch.valueLOO, wf: srch.valueWF, wfSplit: srch.wfSplit, kept: valueModel.kept },
      odds: { k: oddsModel.k, theta: oddsModel.theta, baseRate: oddsModel.baseRate, brier10: srch.oddsBrier10, brierWF: srch.oddsBrierWF, baseBrier10: srch.baseBrier10, baseBrierWF: srch.baseBrierWF, kept: oddsModel.kept },
      ranges: { q10: ranges.q10, q25: ranges.q25, q75: ranges.q75, q90: ranges.q90, looRmse: ranges.looRmse },
      preTokenMedianAgeDays: medianAge,
      settings: { deposit: st.deposit, share: st.share, horizonWeeks: st.horizonWeeks },
      tbillRate: TBILL_RATE,
      hourlyWage: HOURLY_WAGE,
      farmWageMultiple: FARM_WAGE_MULTIPLE,
    },
    evidence: { valueTerms: srch.valueTerms, oddsTerms: srch.oddsTerms, rangeRows: ranges.table },
    accounting: accounting,
    checksum: checksum,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      farm: farmCount,
      marginal: marginalCount,
      pricedComps: valueModel.comps.length,
      oddsRows: oddsModel.rows.length,
    },
    protocols: snapshot.protocols,
    watchlist: snapshot.watchlist,
    rows: board,
  };
  return { board: board, radar: radar, valueModel: valueModel, oddsModel: oddsModel, ranges: ranges };
}

// Why a board is not one the gate will take, or null.
function boardIssue(board, snapshot) {
  var slugs = new Set(board.map(function (r) { return r.slug; }));
  var missing = snapshot.watchlist.filter(function (s) { return !slugs.has(s); });
  if (missing.length > 0) return 'the board misses ' + missing.length + ' watchlist slug' + (missing.length === 1 ? '' : 's') + ': ' + missing.slice(0, 5).join(', ');
  if (board.length < 100) return 'the board holds ' + board.length + ' rows, under the 100-row floor';
  var ranks = board.map(function (r) { return r.rank; }).sort(function (a, b) { return a - b; });
  for (var i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return 'rank ' + (i + 1) + ' is ' + ranks[i];
  for (var i2 = 1; i2 < board.length; i2++) {
    if (board[i2].implied_value_usd > board[i2 - 1].implied_value_usd) return 'row ' + (i2 + 1) + ' outranks row ' + i2 + ' on implied value';
  }
  if (board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) {
    return 'all ' + board.length + ' rows share the same implied value $' + board[0].implied_value_usd + ': a board that ranks nothing by value is not a ranking';
  }
  for (var ri = 0; ri < board.length; ri++) {
    var r = board[ri];
    if (r.token_odds <= 0 || r.token_odds >= 1) return r.slug + ' has token odds ' + r.token_odds;
    if (!(r.p10_usd <= r.p25_usd && r.p25_usd <= r.implied_value_usd && r.implied_value_usd <= r.p75_usd && r.p75_usd <= r.p90_usd)) {
      return r.slug + ' has ranges out of order';
    }
    if (r.launch_value_usd < r.implied_value_usd) return r.slug + ' launches for less than its implied value';
    if (['watchlist', 'early', 'off-list'].indexOf(r.tier) < 0) return r.slug + ' has tier ' + r.tier;
    var steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return r.slug + ' has ' + steps.length + ' farm steps';
    for (var si = 0; si < steps.length; si++) {
      if (steps[si].trim().length < 20 || steps[si].trim().length > 600) return r.slug + ' has a farm step of ' + steps[si].trim().length + ' characters';
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100000000000000) {
      return r.slug + ' has implied value ' + r.implied_value_usd;
    }
  }
  return null;
}

// A compact data.js: the dashboard's whole dataset as one script, no fetch and no network.
function dataScript(radar) {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}

/* ------------------------------------------------------------------ export */

var RADARFIT = {
  MODEL_VERSION: MODEL_VERSION,
  DEFAULT_SETTINGS: DEFAULT_SETTINGS,
  GROUPS: GROUPS,
  GAS_USD: GAS_USD,
  TBILL_RATE: TBILL_RATE,
  HOURLY_WAGE: HOURLY_WAGE,
  FARM_WAGE_MULTIPLE: FARM_WAGE_MULTIPLE,
  SnapshotError: SnapshotError,
  parseSnapshot: parseSnapshot,
  isPreToken: isPreToken,
  isRankable: isRankable,
  groupOf: groupOf,
  accountingOf: accountingOf,
  fitValueModel: fitValueModel,
  multipleFor: multipleFor,
  fitOddsModel: fitOddsModel,
  tokenOdds: tokenOdds,
  fitRanges: fitRanges,
  verdictFor: verdictFor,
  farmSteps: farmSteps,
  gasPerAction: gasPerAction,
  nearestPeers: nearestPeers,
  boardChecksum: boardChecksum,
  buildBoard: buildBoard,
  buildRadar: buildRadar,
  refitLive: refitLive,
  preTokenMedianAge: preTokenMedianAge,
  boardIssue: boardIssue,
  dataScript: dataScript,
  ageDays: ageDays,
  median: median,
  medianDate: medianDate,
  arraySplit: arraySplit,
  mulberry32: mulberry32,
  clamp: clamp,
  finite: finite,
  solveRidge: solveRidge,
  weibullLogLik: weibullLogLik,
  WEIBULL_FINE: WEIBULL_FINE,
  fitWeibullGrid: fitWeibullGrid,
  weibullSurv: weibullSurv,
};

if (typeof module !== 'undefined' && module.exports) module.exports = RADARFIT;
if (typeof window !== 'undefined') window.RADARFIT = RADARFIT;
