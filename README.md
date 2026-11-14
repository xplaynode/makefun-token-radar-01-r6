# Launch Radar

A token launch radar for make.fun's token-radar-01: it reads the sealed DefiLlama snapshot, finds the protocols that record no token yet and are not products of tokens that already trade, prices each one's launch off the snapshot's own token families, and hands the reader a costed eight-step farm plan for every row.

## What it does

The program scans all **758** records in the snapshot and sorts them with rules that read only the snapshot's own ten fields per record — no protocol name is ever special-cased:

- **342** records are pre-token: `mcap_usd`, `gecko_id` and `symbol` are all null — the record carries no token at all.
- **144** of those are set aside as **products**, each carrying the rule that set it aside: an excluded category (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX), a versioned name, a whole word *wrapped* / *staked* / *staking*, or an exchange-name prefix. This is the same product rule the snapshot's watchlist was built with, applied to every pre-token record, and the Products view names every one of the 144 with its rule.
- **198 candidates** remain — pre-token protocols in their own right — and are ranked by implied value. The board covers **40 of 40** watchlist slugs (the watchlist is a floor, never a ceiling: 158 ranked rows sit outside it).
- Protocols whose token already trades are **never ranked**. The **30** largest by market cap stand in the Already trading view at the market's own values, marked UNRANKED. The remaining token-linked records (deployments carrying a family symbol but no market cap of their own) are counted in the 758 scanned and explained on the page.
- **128 peers** — tokenised protocols with a usable market cap (`mcap_usd > 0`) and TVL > 0 — price the model and fill the backtest. Sixteen tokenised records carry a $0 or negative placeholder cap and cannot price anything; they are excluded from the peer set and the backtest, and the dashboard says so.

### The value model

`implied_value_usd = TVL × category multiple × momentum × seasoning × breadth`, computed from rounded factors so the dashboard's live recomputation lands on the same dollar board.json carries.

- **Category multiple.** A peer's multiple is market cap / TVL. A category is priced at the median of its peers' multiples, shrunk toward the global median (0.2138 across the 128 peers) with K pseudo-peers: `mult = (n × category_median + K × global_median) / (n + K)`, with **K = 6**, or **K = 12** when the category has fewer than 3 peers. The result is **clamped to [0.02, 2.00]**; a category with no peers is priced at the global median itself. `value_lo_usd` / `value_hi_usd` repeat the same shrink and clamp with the category's Q1 / Q3 peer multiples in place of the median.
- **Momentum** = `1 + 0.5 × clamp(change_7d, −50%, +100%) / 100` — a factor of 0.75 to 1.50; an unreported change counts as 0.
- **Seasoning** = `1 + 0.20 × min(age_days, 1460) / 1460` — at most ×1.20 at four years. Age runs from `listed_at` to the snapshot's `as_of` (2026-11-14); a record with no listing date is seasoned at the median age of the pre-token protocols, **513 days**.
- **Breadth** = `min(1 + 0.03 × (chains − 1), 1.21)`.
- **Backtest** (computed in `main.ts`'s model, shipped in `data.js`, displayed on the dashboard): pricing all 128 peers with their own category multiples gives a median absolute percentage error of **84.1%** against the recorded market caps and a hit rate of **26.6%** (34 of 128 fitted values inside [0.5×, 2×] of the actual cap). The model is a blunt peer ruler, and the page says so.

### Farm plans

Every candidate carries exactly **8 farm steps**, generated from the row's own features — never from a list of names. The category picks the core and second-leg actions from a per-category table covering all 33 categories on the board (DEX: swap route + LP position; lending: supply + borrow/repay; perps: hedged pair; bridge: routed volume both ways; curators: vault deposits; and so on). The lead chain prices gas by chain class (Ethereum $6 per transaction, other L1s and L2s $1–$2). TVL sizes the working capital ($250–$2,500 across five tiers). Age sets the hold: 84 days minus 7 per full year of age, floored at 28 and capped at 84. Each step names an action, an explicit out-of-pocket cost and a time, and ends with the exact tail ` [cost $X | Y min]` that the dashboard parses into Cost/Time pills. Step costs are gas and fees only — working capital is deployed, not spent, is named in the step text, and never appears in a cost tail. Each row's plan object (`capital_usd`, `gas_usd`, `hold_days`, `weeks`, `minutes_total`, `minutes_per_week`) is built so `gas_usd` and `minutes_total` equal the exact sums of the eight step tails; the self-test re-verifies that on every row.

### The dashboard

Three files only — `dashboard/index.html` (648 bytes), `dashboard/app.js` (25,395 bytes), `dashboard/app.css` (8,692 bytes, 124 rules) — **34,735 bytes** in total, no framework, no network. After a real run the dossier text assembled from that source is **34,940 chars** (34,999 bytes), inside the 65,536-byte cap the judge reads with room to spare. The landing view is, top to bottom: the Launch Radar header with its stat block (758 scanned, 198 ranked, 40/40 watchlist, snapshot date); the method panel with the formula, the full prose derivation of every factor, the measured category-multiples table (33 categories, deepest peer sets first), the backtest block and the set-aside honesty note; the three view tabs; the controls row (search, category select with per-category counts, chain select over all 116 chains on the board, tier select, and the “N of 198 candidates” count); and the sortable board (click a header to toggle direction, with a ^/v indicator). Every view, detail slug, filter and sort lives in the URL and is restored on load, so boards and protocols deep-link. The detail view shows the record, the model's arithmetic as a factor-chips row recomputed live from the shipped factors, the shrunk-median prose for that category, the named-peers table behind the multiple, the quartile value range, and the farm plan with its summary chips and per-step Cost/Time pills. The Products view lists all 144 set-asides at their own TVLs with their rules; the Already trading view lists the 30 largest live tokens at market values, marked unranked. Styling is a dark ink-navy theme with a single amber accent, hairline dividers, tabular numerals, two pill tones (watchlist / early, the latter reading “EARLY — BELOW THE $50M FLOOR” on detail pages), panel cards, and responsive rules down through the 1440×900 render.

## Layout

| Path | What it is |
| --- | --- |
| `main.ts` | The program: reads the snapshot, writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to the output directory. |
| `lib/model.ts` | Classification, peer multiples, the value model, backtests, farm plans, snapshot parsing and board validation. |
| `vendor/makefun-board.ts` | The kit's dossier library, vendored byte for byte — sha256 `9ca51b6e5cd84fe46cb0efa61e2ea99365a1fb0e21f2b75e6007f977f0dc326e`. |
| `dashboard/index.html` | Page shell: loads `../data.js`, then `app.js`. |
| `dashboard/app.js` | All rendering: board, detail, products, live; URL routing; live implied-value recomputation; step-tail parsing. |
| `dashboard/app.css` | The theme: 124 rules, dark ink-navy, one accent. |
| `screenshots/1-board.png` | The landing board, unfiltered (1440×900, 300,740 bytes). |
| `screenshots/2-detail.png` | Detail view of the rank-#1 protocol, Steakhouse Financial (1440×900, 228,992 bytes). |
| `screenshots/3-filtered.png` | The board filtered to Dexs — “21 of 198 candidates” (1440×900, 295,171 bytes). |
| `tools/selftest.mjs` | The self-test: restates the gate rows and this entry's stricter contract, and checks a real double run. |
| `LICENSE` | MIT. |

Screenshots are rendered from the shipped dashboard plus generated data in headless Chromium at exactly 1440×900, e.g. `chrome --headless --window-size=1440,900 --screenshot=screenshots/1-board.png "file://…/out/dashboard/index.html"` (the detail and filtered shots add `#view=detail&slug=steakhouse-financial` and `#view=board&category=Dexs`).

## Run it

Node ≥ 22, standard library only, no network. The snapshot is the kit's `input/snapshot.json` (in the grader it is mounted at `/input/snapshot.json`):

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
node tools/selftest.mjs --input ../input/snapshot.json
```

There is no separate data-only mode: one run is the data pass and the packaging pass together — it writes `board.json` and `data.js` first, then copies `dashboard/` and `screenshots/`, then writes `dossier.json` last, and two consecutive runs over the same snapshot are byte-identical (the self-test proves it).

## Verification

The real run of this entry prints:

```
launch radar: 758 protocols scanned, 40 of 40 watchlist covered, 198 candidates ranked, 144 products set aside, 30 live tokens shown apart, 128 peers priced the model
```

The self-test, run against the same snapshot, passes all 13 checks:

```
PASS board row count — 198 rows (entry contract 198, gate range 100..4000)
PASS ranks 1..N — ranks are exactly 1..198, once each
PASS slugs valid — every slug is a snapshot protocol, unique, 1..128 chars, no whitespace
PASS watchlist coverage — 40/40 watchlist slugs on the board
PASS sorted by value — implied_value_usd never rises as rank ascends, and the board is not flat
PASS farm steps — every row carries exactly 8 steps (gate range 3..12), each 20..600 chars with the [cost $X | Y min] tail
PASS plan totals — each plan's gas_usd and minutes_total equal the sums of its 8 step tails
PASS no network — no network pattern in 5 program + dashboard files
PASS dashboard files — 3 files (app.css, app.js, index.html), 34735 bytes total (gate cap 400 files / 4 MiB)
PASS screenshots — 3 images, each a 1440x900 PNG of at most 512 KiB — 1-board.png 1440x900 300740B; 2-detail.png 1440x900 228992B; 3-filtered.png 1440x900 295171B;
PASS dossier size — dossier 1136272 bytes (cap 1.5 MiB), text 34999 bytes / 34940 chars (cap 65,536)
PASS dossier rebuild — buildDossier(output) reproduces dossier.json byte for byte
PASS determinism — two consecutive runs byte-identical (board.json true, data.js true, dossier.json true)
selftest: all 13 checks passed
```

Top 5 of the board, from that same run:

| # | Protocol | Category | TVL | Implied value | Range (lo–hi) |
| --- | --- | --- | --- | --- | --- |
| 1 | Steakhouse Financial | Risk Curators | $2,753,981,495 | $1,509,078,410 | $963,181,116 – $4,231,599,878 |
| 2 | Sentora Curator | Risk Curators | $2,757,585,593 | $1,368,431,472 | $873,412,107 – $3,837,212,441 |
| 3 | Gauntlet | Risk Curators | $1,577,685,462 | $898,770,042 | $573,647,020 – $2,520,236,971 |
| 4 | Polymarket International | Prediction Market | $320,193,439 | $764,308,399 | $764,308,399 – $764,308,399 |
| 5 | Veda | Onchain Capital Allocator | $1,563,415,482 | $364,594,170 | $81,600,417 – $1,772,239,289 |

(Row 4's range collapses to a point: its single peer's multiple is so large that the median and both quartile multiples all clamp to 2.00. That is the clamp working as specified, shown rather than smoothed away.)

## Honest limits

The implied value is a peer ruler, not a forecast: it prices a protocol as if its token would trade at its category's shrunk median market-cap/TVL, and the backtest above — a median error of 84.1% on the very peers the multiples come from — is the honest measure of how blunt that ruler is. The snapshot records no token for a candidate; that is DefiLlama's record, not proof that no token exists, and the dashboard words it that way. Categories with one or two peers (Risk Curators has exactly one) lean heavily on the global median by design, so their multiples say more about the market than about the category. Farm plans are templates derived from category, chain, TVL and age — concrete and costed, but a reader must still check the protocol's own app and terms before deploying capital, and gas is priced at flat per-transaction class rates, not live network quotes. Nothing here predicts whether or when any protocol issues a token.

## License

MIT — see `LICENSE` (SPDX-License-Identifier: MIT).
