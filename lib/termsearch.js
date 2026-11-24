// Launch Radar term search (Node only, lib/termsearch.js).
//
// The both-tests term selection for the value model and the token-odds model.
// Runs at build time inside main.ts; the browser never runs this file — it
// refits the surviving model live from the embedded snapshot and reads these
// evidence tables out of data.js. The general fitting machinery lives here
// (the browser's dashboard/fit.js carries only the surviving model), and
// only the small shared primitives come from fit.js, so the search and the
// live fit can never disagree about how a score is computed.
//
// Value model: start from the flat median multiple, test each term in order,
// keep it only when it lowers the held-out error in BOTH leave-one-out AND
// walk-forward (train on tokens listed earlier, test on later ones). The
// leakage probe (another row's growth) is tested but never kept.
// Odds model: the flat base rate, then the Weibull age baseline, then each
// candidate term in order, kept only when it lowers the Brier score in BOTH
// ten-fold cross-validation AND walk-forward, by at least the noise floor.

'use strict';

var fit = require('../dashboard/fit.js');

// Shared primitives from fit.js (the browser carries these too).
var clamp = fit.clamp, finite = fit.finite, median = fit.median,
  solveRidge = fit.solveRidge, ageDays = fit.ageDays,
  weibullLogLik = fit.weibullLogLik, WEIBULL_FINE = fit.WEIBULL_FINE,
  isPreToken = fit.isPreToken;

var VALUE_CANDIDATES = [
  { name: 'size', label: 'Size curve (log TVL)', kind: 'cont' },
  { name: 'fam', label: 'Family effect', kind: 'dum' },
  { name: 'cat', label: 'Category effect', kind: 'dum' },
  { name: 'growth', label: '7-day TVL growth', kind: 'cont' },
  { name: 'age', label: 'Age (log days, no token)', kind: 'cont' },
  { name: 'chains', label: 'Chain count', kind: 'cont' },
  { name: 'leader', label: 'Growth of another row (largest priced peer, same category)', kind: 'cont', leak: true },
];

var LAMBDA_CONT = 1.0;

var LAMBDA_DUM = 5.0;

var MIN_DUMMY_COUNT = 3;

function familyOf(p) {
  var n = p.name
    .replace(/\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '');
  var w = n.split(/\s+/).filter(function (s) { return s.length > 0; });
  return w.length > 0 ? w[0] : 'other';
}

function valueFeatures(p, comps, asOf) {
  var age = ageDays(asOf, p.listed_at);
  var ageD = age === null ? 365 : age;
  var best = null;
  for (var i = 0; i < comps.length; i++) {
    var q = comps[i];
    if (q.slug === p.slug) continue;
    if ((q.category || 'Other') !== (p.category || 'Other')) continue;
    if (best === null || q.tvl_usd > best.tvl_usd) best = q;
  }
  return {
    size: Math.log10(p.tvl_usd),
    growth: clamp(finite(p.change_7d, 0), -50, 200) / 100,
    age: Math.log(Math.max(ageD, 1)),
    chains: Math.min(p.chains.length, 6),
    leader: best === null ? 0 : clamp(finite(best.change_7d, 0), -50, 200) / 100,
    fam: familyOf(p),
    cat: p.category || 'Other',
  };
}

function fitValueTerms(train, featureNames) {
  var y = train.map(function (r) { return r.y; });
  var med = median(y) || 0;
  var cols = [];
  var lambdas = [];
  var stats = [];
  for (var fi = 0; fi < featureNames.length; fi++) {
    var cand = null;
    for (var ci = 0; ci < VALUE_CANDIDATES.length; ci++) {
      if (VALUE_CANDIDATES[ci].name === featureNames[fi]) cand = VALUE_CANDIDATES[ci];
    }
    if (cand === null) continue;
    if (cand.kind === 'cont') {
      var vals = train.map(function (r) { return r.f[cand.name]; });
      var mu = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / vals.length) || 1;
      stats.push({ kind: 'cont', name: cand.name, mu: mu, sd: sd });
      cols.push({ kind: 'cont', name: cand.name, mu: mu, sd: sd });
      lambdas.push(LAMBDA_CONT);
    } else {
      var counts = {};
      train.forEach(function (r) {
        var g = r.f[cand.name];
        counts[g] = (counts[g] || 0) + 1;
      });
      var groups = Object.keys(counts)
        .filter(function (g) { return counts[g] >= MIN_DUMMY_COUNT; })
        .sort();
      stats.push({ kind: 'dum', name: cand.name, groups: groups });
      for (var gi = 0; gi < groups.length; gi++) {
        cols.push({ kind: 'dum', name: cand.name, group: groups[gi] });
        lambdas.push(LAMBDA_DUM);
      }
    }
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
      for (var cj = 0; cj < k; cj++) {
        var col = cols[cj];
        if (col.kind === 'cont') xv[cj] = (r.f[col.name] - col.mu) / col.sd;
        else xv[cj] = r.f[col.name] === col.group ? 1 : 0;
      }
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
    for (var j = 0; j < k; j++) {
      var col = cols[j];
      if (col.kind === 'cont') s += beta[j] * ((f[col.name] - col.mu) / col.sd);
      else if (f[col.name] === col.group) s += beta[j];
    }
    return s;
  }
  return { med: med, beta: beta, cols: cols, stats: stats, predict: predict };
}

function valueComps(snapshot) {
  var priced = snapshot.protocols.filter(function (p) { return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0; });
  return priced.map(function (p) {
    return { p: p, y: Math.log(p.mcap_usd / p.tvl_usd), f: valueFeatures(p, priced, snapshot.as_of) };
  });
}

var ODDS_CANDIDATES = [
  { name: 'size', label: 'Size curve (log TVL)', kind: 'cont' },
  { name: 'growth', label: '7-day TVL growth', kind: 'cont' },
  { name: 'chains', label: 'Chain count', kind: 'cont' },
  { name: 'fam', label: 'Family effect', kind: 'dum' },
  { name: 'cat', label: 'Category effect', kind: 'dum' },
];

var BRIER_NOISE_FLOOR = 0.001;

var ODDS_MIN_DUMMY_COUNT = 5;

var WEIBULL_COARSE = { kMin: 0.2, kMax: 2.0, kStep: 0.05, thMin: 0.3, thMax: 12.0, thStep: 0.25 };

function fitOddsBeta(ages, y, k, th, X) {
  var m = X.length > 0 ? X[0].length : 0;
  if (m === 0) return [];
  var beta = new Array(m).fill(0);
  function ll(b) {
    var lam = new Array(ages.length);
    for (var i = 0; i < ages.length; i++) {
      var s = 0;
      for (var j = 0; j < m; j++) s += X[i][j] * b[j];
      lam[i] = Math.exp(s);
    }
    return weibullLogLik(k, th, ages, y, lam);
  }
  var cur = ll(beta);
  var step = 0.5;
  for (var round = 0; round < 12; round++) {
    var improved = false;
    for (var j = 0; j < m; j++) {
      for (var d = 0; d < 2; d++) {
        var b2 = beta.slice();
        b2[j] += d === 0 ? step : -step;
        var v = ll(b2);
        if (v > cur + 1e-9) {
          beta = b2;
          cur = v;
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
    if (step < 0.01) break;
  }
  return beta;
}

function oddsFeatures(p, asOf) {
  return {
    size: Math.log10(p.tvl_usd),
    growth: clamp(finite(p.change_7d, 0), -50, 200) / 100,
    chains: Math.min(p.chains.length, 6),
    fam: familyOf(p),
    cat: p.category || 'Other',
  };
}

function oddsDesign(rows, featureNames) {
  var cols = [];
  for (var fi = 0; fi < featureNames.length; fi++) {
    var cand = null;
    for (var ci = 0; ci < ODDS_CANDIDATES.length; ci++) {
      if (ODDS_CANDIDATES[ci].name === featureNames[fi]) cand = ODDS_CANDIDATES[ci];
    }
    if (cand === null) continue;
    if (cand.kind === 'cont') {
      var vals = rows.map(function (r) { return r.f[cand.name]; });
      var mu = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / vals.length) || 1;
      cols.push({ kind: 'cont', name: cand.name, mu: mu, sd: sd });
    } else {
      var counts = {};
      rows.forEach(function (r) {
        var g = r.f[cand.name];
        counts[g] = (counts[g] || 0) + 1;
      });
      var groups = Object.keys(counts)
        .filter(function (g) { return counts[g] >= ODDS_MIN_DUMMY_COUNT; })
        .sort();
      for (var gi = 0; gi < groups.length; gi++) cols.push({ kind: 'dum', name: cand.name, group: groups[gi] });
    }
  }
  function matrix(rs) {
    return rs.map(function (r) {
      return cols.map(function (c) {
        if (c.kind === 'cont') return (r.f[c.name] - c.mu) / c.sd;
        return r.f[c.name] === c.group ? 1 : 0;
      });
    });
  }
  return { cols: cols, matrix: matrix };
}

function oddsPredict(rows, k, th, design, beta) {
  var X = design.matrix(rows);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var s = 0;
    for (var j = 0; j < beta.length; j++) s += X[i][j] * beta[j];
    var lam = Math.exp(s);
    out.push(1 - Math.exp(-Math.pow(rows[i].ageYears / th, k) * lam));
  }
  return out;
}

function brier(pred, y) {
  var s = 0;
  for (var i = 0; i < y.length; i++) {
    var d = pred[i] - y[i];
    s += d * d;
  }
  return s / y.length;
}

function oddsRows(snapshot) {
  return snapshot.protocols
    .filter(function (p) { return p.listed_at !== null; })
    .map(function (p) {
      var ageD = ageDays(snapshot.as_of, p.listed_at);
      return { p: p, ageYears: ageD / 365.25, y: isPreToken(p) ? 0 : 1, f: oddsFeatures(p, snapshot.as_of) };
    });
}

/* ------------------------------------------------------- value search */

// The leave-one-out RMSE of a feature set over all priced comps.
function valueLOO(comps, featureNames) {
  var se = 0;
  for (var i = 0; i < comps.length; i++) {
    var train = [];
    for (var j = 0; j < comps.length; j++) if (j !== i) train.push(comps[j]);
    var m = fitValueTerms(train, featureNames);
    var e = comps[i].y - m.predict(comps[i].f);
    se += e * e;
  }
  return Math.sqrt(se / comps.length);
}

// The walk-forward RMSE: train on tokens listed earlier, test on later ones.
function valueWF(comps, featureNames) {
  var dated = comps.filter(function (r) { return r.p.listed_at !== null; });
  if (dated.length < 10) return NaN;
  var split = fit.medianDate(dated.map(function (r) { return r.p.listed_at; }));
  var train = dated.filter(function (r) { return r.p.listed_at < split; });
  var test = dated.filter(function (r) { return r.p.listed_at >= split; });
  if (train.length === 0 || test.length === 0) return NaN;
  var m = fitValueTerms(train, featureNames);
  var se = 0;
  for (var i = 0; i < test.length; i++) {
    var e = test[i].y - m.predict(test[i].f);
    se += e * e;
  }
  return { rmse: Math.sqrt(se / test.length), split: split, nTrain: train.length, nTest: test.length };
}

/** The value model's term search; returns the surviving set and the table. */
function searchValue(snapshot) {
  var comps = valueComps(snapshot);
  var asOf = snapshot.as_of;
  var baseLOO = valueLOO(comps, []);
  var baseWF = valueWF(comps, []);
  var rows = [{ term: 'Baseline (flat median multiple)', loo: baseLOO, wf: baseWF.rmse, status: 'baseline' }];
  var kept = [];
  var curLOO = baseLOO;
  var curWF = baseWF.rmse;
  for (var i = 0; i < VALUE_CANDIDATES.length; i++) {
    var cand = VALUE_CANDIDATES[i];
    var trial = kept.concat([cand.name]);
    var loo = valueLOO(comps, trial);
    var wf = valueWF(comps, trial).rmse;
    if (cand.leak) {
      rows.push({ term: cand.label, loo: loo, wf: wf, status: 'must not help' });
      continue;
    }
    if (loo < curLOO && wf < curWF) {
      kept.push(cand.name);
      curLOO = loo;
      curWF = wf;
      rows.push({ term: cand.label, loo: loo, wf: wf, status: 'kept' });
    } else {
      rows.push({ term: cand.label, loo: loo, wf: wf, status: 'tested, not kept' });
    }
  }
  return { kept: kept, terms: rows, loo: curLOO, wf: curWF, wfSplit: baseWF.split };
}

/* -------------------------------------------------------- odds search */

/**
 * Ten-fold and walk-forward Brier scores for an odds feature set. Ten-fold
 * uses a seeded shuffle; walk-forward trains on protocols listed earlier and
 * tests on later ones. The Weibull (k, theta) is refit inside every fold on
 * the coarse grid, so no fold sees its own test rows. With no features the
 * prediction is the flat token rate of the training rows.
 */
function oddsScores(rows, featureNames) {
  var n = rows.length;
  var rng = fit.mulberry32(7);
  var perm = rows.map(function (r, i) { return i; });
  for (var i = perm.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  var folds = fit.arraySplit(perm, 10);
  var sq = 0;
  var cnt = 0;
  for (var f = 0; f < folds.length; f++) {
    var testSet = {};
    folds[f].forEach(function (idx) { testSet[idx] = true; });
    var tr = [];
    var te = [];
    for (var i2 = 0; i2 < n; i2++) {
      if (testSet[i2]) te.push(rows[i2]);
      else tr.push(rows[i2]);
    }
    if (featureNames.length === 0) {
      var rate = tr.reduce(function (a, r) { return a + r.y; }, 0) / tr.length;
      for (var ti = 0; ti < te.length; ti++) {
        var d = rate - te[ti].y;
        sq += d * d;
        cnt++;
      }
      continue;
    }
    var w = fit.fitWeibullGrid(tr.map(function (r) { return r.ageYears; }), tr.map(function (r) { return r.y; }), WEIBULL_COARSE);
    var design = oddsDesign(tr, featureNames);
    var beta = fitOddsBeta(tr.map(function (r) { return r.ageYears; }), tr.map(function (r) { return r.y; }), w.k, w.th, design.matrix(tr));
    var pred = oddsPredict(te, w.k, w.th, design, beta);
    for (var pi = 0; pi < te.length; pi++) {
      var dd = pred[pi] - te[pi].y;
      sq += dd * dd;
      cnt++;
    }
  }
  var brier10 = sq / cnt;
  var split = fit.medianDate(rows.map(function (r) { return r.p.listed_at; }));
  var wtr = rows.filter(function (r) { return r.p.listed_at < split; });
  var wte = rows.filter(function (r) { return r.p.listed_at >= split; });
  var brierWF;
  if (featureNames.length === 0) {
    var wrate = wtr.reduce(function (a, r) { return a + r.y; }, 0) / wtr.length;
    brierWF = brier(wte.map(function () { return wrate; }), wte.map(function (r) { return r.y; }));
  } else {
    var ww = fit.fitWeibullGrid(wtr.map(function (r) { return r.ageYears; }), wtr.map(function (r) { return r.y; }), WEIBULL_COARSE);
    var wdesign = oddsDesign(wtr, featureNames);
    var wbeta = fitOddsBeta(wtr.map(function (r) { return r.ageYears; }), wtr.map(function (r) { return r.y; }), ww.k, ww.th, wdesign.matrix(wtr));
    brierWF = brier(oddsPredict(wte, ww.k, ww.th, wdesign, wbeta), wte.map(function (r) { return r.y; }));
  }
  return { brier10: brier10, brierWF: brierWF, wfSplit: split, nTrain: wtr.length, nTest: wte.length };
}

/**
 * The Weibull age baseline scored the same way (flat rate is the reference):
 * ten-fold and walk-forward Brier of P(has token by this age) from the Weibull
 * alone, with (k, theta) refit inside every fold.
 */
function ageBaselineScores(rows) {
  var rng = fit.mulberry32(7);
  var perm = rows.map(function (r, i) { return i; });
  for (var i = perm.length - 1; i > 0; i--) {
    var j = Math.floor(rng() * (i + 1));
    var t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  var folds = fit.arraySplit(perm, 10);
  var sq = 0;
  var cnt = 0;
  for (var f = 0; f < folds.length; f++) {
    var testSet = {};
    folds[f].forEach(function (idx) { testSet[idx] = true; });
    var tr = [];
    var te = [];
    for (var i2 = 0; i2 < rows.length; i2++) {
      if (testSet[i2]) te.push(rows[i2]);
      else tr.push(rows[i2]);
    }
    var w = fit.fitWeibullGrid(tr.map(function (r) { return r.ageYears; }), tr.map(function (r) { return r.y; }), WEIBULL_COARSE);
    for (var ti = 0; ti < te.length; ti++) {
      var pr = 1 - fit.weibullSurv(te[ti].ageYears, w.k, w.th);
      var d = pr - te[ti].y;
      sq += d * d;
      cnt++;
    }
  }
  var split = fit.medianDate(rows.map(function (r) { return r.p.listed_at; }));
  var wtr = rows.filter(function (r) { return r.p.listed_at < split; });
  var wte = rows.filter(function (r) { return r.p.listed_at >= split; });
  var ww = fit.fitWeibullGrid(wtr.map(function (r) { return r.ageYears; }), wtr.map(function (r) { return r.y; }), WEIBULL_COARSE);
  var bwf = brier(wte.map(function (r) { return 1 - fit.weibullSurv(r.ageYears, ww.k, ww.th); }), wte.map(function (r) { return r.y; }));
  return { brier10: sq / cnt, brierWF: bwf };
}

/** The odds model's term search; returns the surviving set and the table. */
function searchOdds(snapshot) {
  var rows = oddsRows(snapshot);
  var base = oddsScores(rows, []);
  var age = ageBaselineScores(rows);
  var table = [
    { term: 'Base rate (flat token rate)', brier10: base.brier10, brierWF: base.brierWF, status: 'baseline' },
    { term: 'Age (Weibull time to token)', brier10: age.brier10, brierWF: age.brierWF, status: 'kept' },
  ];
  var kept = [];
  var cur10 = age.brier10;
  var curWF = age.brierWF;
  for (var i = 0; i < ODDS_CANDIDATES.length; i++) {
    var cand = ODDS_CANDIDATES[i];
    var s = oddsScores(rows, kept.concat([cand.name]));
    if (s.brier10 < cur10 - BRIER_NOISE_FLOOR && s.brierWF < curWF - BRIER_NOISE_FLOOR) {
      kept.push(cand.name);
      cur10 = s.brier10;
      curWF = s.brierWF;
      table.push({ term: cand.label, brier10: s.brier10, brierWF: s.brierWF, status: 'kept' });
    } else {
      table.push({ term: cand.label, brier10: s.brier10, brierWF: s.brierWF, status: 'tested, not kept' });
    }
  }
  return { kept: kept, terms: table, brier10: cur10, brierWF: curWF, baseBrier10: base.brier10, baseBrierWF: base.brierWF };
}

/** Both searches at once: the surviving sets, the evidence tables, the headline scores. */
function searchTerms(snapshot) {
  var v = searchValue(snapshot);
  var o = searchOdds(snapshot);
  return {
    valueKept: v.kept,
    valueTerms: v.terms,
    valueLOO: v.loo,
    valueWF: v.wf,
    wfSplit: v.wfSplit,
    oddsKept: o.kept,
    oddsTerms: o.terms,
    oddsBrier10: o.brier10,
    oddsBrierWF: o.brierWF,
    baseBrier10: o.baseBrier10,
    baseBrierWF: o.baseBrierWF,
  };
}

module.exports = { searchTerms: searchTerms, searchValue: searchValue, searchOdds: searchOdds, oddsScores: oddsScores, ageBaselineScores: ageBaselineScores, valueLOO: valueLOO, valueWF: valueWF };
