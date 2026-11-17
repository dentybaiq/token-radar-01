# Token Radar — token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dentybaiq/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dentybaiq/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed snapshot of the protocol universe, ranks the
protocols that record no token yet by what their launch would be worth, and hands in a
web dashboard with the board, a detail view for every protocol, and a farm plan for each.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
```

Node 22, standard library only, no network. The program runs twice in grading and both
runs write identical bytes: every date comes from the snapshot's own `as_of`.

## The model (radar-2)

One function, `impliedValue` in `lib/model.ts`, scores every row from the snapshot's own
figures. No protocol name is special-cased.

- **Multiple** — the median market-cap-per-TVL of the token-bearing protocols in the same
  category (at least 3 of them), else the global median across all live protocols; clamped
  to x0.05–x1.50. On this snapshot the global median is about x0.205, Dexs sit near x0.34
  and Lending near x0.13, which is why the multiple is per category.
- **Base** — `tvl_usd x multiple`.
- **Growth** — `1 + clamp(change_7d, -50%, +200%) / 100 x 0.5` (0.75–2.00).
- **Maturity** — `0.7 + min(age_days, 1095) / 1095 x 0.6` (0.70–1.30); age is the time since
  the protocol was first listed, unknown age counts as 365 days. The longer a protocol has
  run with no token, the higher the factor.
- **Breadth** — `1 + min(chains - 1, 4) x 0.05` (1.00–1.20).
- **Implied value** — `max(1, round(base x growth x maturity x breadth))`.

## The board

The board holds every rankable pre-token protocol: the whole 40-protocol watchlist plus
every other pre-token protocol below the floor that is not a wrapped, staked or bridged
product and not a versioned pool — 198 rows on this snapshot. Protocols whose token
already trades never enter the ranking; the dashboard shows the top 24 of them separately
with their market cap, which is a fact, not a model. "No token" always means no token on
record.

## Farm plans

Each row carries a 5-step plan generated from the protocol's own record (category,
chains, TVL, age): a fresh wallet, the category's core action with a capital amount, a
weekly qualifying action, a hold window, and a claim check — every step with a cost in
dollars and a time.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes `board.json`, `data.js`, copies
  `dashboard/` and `screenshots/`, writes `dossier.json` via `vendor/makefun-board.ts`.
- `lib/model.ts` — the snapshot parser, the value model, the board builder, the farm plans.
- `vendor/makefun-board.ts` — make.fun's dossier library, byte for byte from the kit.
- `dashboard/` — the static page (`index.html`, `app.css`, `app.js`); it reads `data.js`,
  renders the sortable, searchable, filterable board, and opens a detail panel per
  protocol with the model's breakdown and its farm plan. No network.
- `screenshots/` — three renders of the real dashboard on this snapshot: the board, a
  protocol's detail view, and a filtered view.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hvjtrkxx&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
