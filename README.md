# Launch Radar — token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dentybaiq/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dentybaiq/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed snapshot of the protocol universe, ranks the
protocols that record no token yet by what their launch would be worth, tells you which
are worth farming, and hands in a web dashboard with the board, the evidence for the
model, a detail view for every protocol, and a farm plan for each.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22, standard library only, no network. The program runs twice in grading and both
runs write identical bytes: every date comes from the snapshot's own `as_of`.

## The model (radar-3)

The model lives in one plain-JavaScript file, `dashboard/fit.js`, so the exact same code
runs in Node (the build) and in the browser (the dashboard refits the surviving model
live from the embedded snapshot and verifies it against the build). The term search
lives in `lib/termsearch.js` and runs only at build time. No protocol name is
special-cased; every number is fitted from the snapshot given.

- **Implied value** — `TVL × fitted market-cap/TVL multiple × token odds`. The multiple
  is the value if a token launches; the odds are the probability it launches within the
  horizon.
- **Value model** — start from a flat median multiple, then add terms one at a time and
  keep a term only when it lowers held-out error in BOTH leave-one-out AND walk-forward
  (train on tokens listed earlier, test on later ones). On this snapshot only the size
  curve survives: 10× the TVL ⇒ ×0.34 the multiple. Family, category, 7-day growth,
  age and chain count were all tested and none survived both tests. The "growth of
  another row" term improves both tests but is excluded by design — a valuation must
  come from a protocol's own record. Out-of-sample walk-forward error is 2.10 log
  points (about ×8.2), so the model is honest about how wide token multiples vary.
- **Token odds** — a Weibull current-status fit on how long peers ran before recording
  a token (shape 0.54, scale 3.0 years; the hazard falls with age). Base rate, then age,
  then size, growth and chain count were tested with ten-fold and walk-forward Brier
  scores; no covariate survived both tests. Walk-forward Brier 0.252 against a flat
  base rate of 0.331.
- **Ranges** — P25–P75 and P10–P90 from the value model's leave-one-out residuals,
  scaled by token odds. Their honesty is measured and bootstrapped: the P25–P75
  interval covered the real cap 50% of the time (target 50%), the P10–P90 interval
  80% of the time (target 80%).
- **Farm verdicts** — expected airdrop = implied value × drop share × (deposit / TVL),
  minus gas by chain, fees, slippage, the T-bill opportunity cost of the deposit, and
  $25/hour for hands-on time. FARM needs net > 0 and net/hour ≥ $31.25; MARGINAL is
  positive but small; SKIP is negative. At the default $1,000 deposit, 10% drop share
  and 26-week horizon, no row clears its costs — farming only pays with a larger
  deposit on small, young protocols, and the dashboard says so.

## The board

The board holds every rankable pre-token protocol: the whole 40-protocol watchlist plus
every other rankable one — 198 rows on this snapshot. Every protocol in the snapshot
lands in exactly one of nine groups so the totals reconcile (ranked watchlist, ranked
early, ranked off-list, token trades, token recorded, out bridge, out liquid staking,
out exchange, out versioned/wrapped). Protocols whose token already trades never enter
the ranking; they are the priced comps the multiple is fitted on. "No token" always
means no token on record.

## Farm plans

Each row carries a 6-step plan generated from the protocol's own record (category,
chains, TVL, age, verdict): a fresh wallet, the category's core action with a capital
amount, check-ins every 4 weeks, a hold window, a claim check, and the verdict with its
numbers — every step with a cost in dollars and a time.

## Layout

- `main.ts` — entrypoint: reads the snapshot, runs the term search, writes `board.json`,
  `data.js`, copies `dashboard/` and `screenshots/`, writes `dossier.json` via
  `vendor/makefun-board.ts`.
- `dashboard/fit.js` — the model (classification, value fit, Weibull odds, ranges,
  farm verdicts, board builder). One file, no imports, no network; Node and the browser
  run the same code.
- `lib/termsearch.js` — the both-tests term selection for the value and odds models.
  Node only; the browser never runs it.
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`); it reads `data.js`,
  refits the surviving model live, verifies it against the build, and renders the KPI
  strip, the protocol accounting with integrity checks, the out-of-sample evidence
  tables, the controls (verdict/tier filters, deposit, drop share, horizon, search,
  category, chain, CSV/JSON export), and the ranked table with expandable detail rows
  (how the figure is made, the farm verdict, the farm plan, the nearest priced peers).
  No network.
- `screenshots/` — three renders of the real dashboard on this snapshot: the board, a
  protocol's detail view, and a filtered view.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hvjtrkxx&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
