# Fifty

Fifty runs one autonomous trading session on a Robinhood Agentic account through the official
Robinhood Trading MCP (`https://agent.robinhood.com/mcp/trading`). It starts with $50 of
contributed capital. The $5,000 figure is a scoreboard, not a plan. Nothing here shows an edge,
no backtest was run, and **the whole $50 is at risk**.

You arm the session. Once armed, it researches before the open, trades during the regular session
without asking about each order, winds down, sells everything before the close, and writes a
report. Then it disarms itself. It never repeats the next day.

## How it is built

```
launchd agent (com.fifty.session, caffeinate -i -s)
  └─ fifty run ── Engine (src/engine.ts): one loop, deterministic polling
       ├─ Strategy (src/strategy/): proposes entries only; replaceable interface
       ├─ optional Claude review (src/decider/claude.ts): may only shrink risk
       ├─ Guard (src/guard.ts): account boundaries and execution controls, pure functions
       ├─ Robinhood (src/broker/robinhood.ts): tool allowlist, one account, schema-exact
       └─ Store (src/state.ts): session.json (atomic) + journal.jsonl (append-only)
```

The model never calls a broker tool. Code places every order, after `guard.ts` has checked it.

Lifecycle: `PRECHECK → RESEARCH → WAIT_FOR_OPEN → ACTIVE → WIND_DOWN → REPORT → COMPLETE`. If
positions remain after the close, the path runs `REPORT → RECOVERY_WAIT → exit-only session at the
next open → REPORT → COMPLETE`.

Foundation choice and pinned commits: [docs/foundation.md](docs/foundation.md).

## Quick start (new user)

```bash
git clone https://github.com/SatyamDave/5000.git ~/fifty && cd ~/fifty && npm ci --ignore-scripts && ./bin/arm-tomorrow
```

`arm-tomorrow` does the whole setup in one go. If there's no sign-in yet, it signs you in. It then
asks for your account number and tickers (Enter = Robinhood's lists) and runs `doctor`. It arms
only after you type `ARM <date>`, then schedules the Mac to wake. If Claude is helping you set up,
point it at [CLAUDE.md](CLAUDE.md).

## Setup (once, step by step)

```bash
cd ~/real_trade && npm ci --ignore-scripts
```

```bash
./bin/fifty login
```

`login` opens Robinhood's own sign-in page in your browser. It stores the OAuth tokens with mode
0600 at `~/.config/fifty/robinhood-oauth.json`, then lists tools once. It never calls a tool.

To reuse the sign-in you already made for fall_forward_labs, prefix commands with
`FIFTY_TOKEN_PATH=~/.config/fall_forward_labs/robinhood-oauth.json`. The two projects share its
refresh lock.

```bash
cp config/fifty.example.json config/fifty.json
```

Then edit `config/fifty.json`. Two things are yours to set:
- `boundaries.account_number`: the Agentic account number. `fifty doctor` shows the last 4 digits
  of every agentic account the sign-in can see.
- `universe` and/or `universe_lists`: what the strategy may trade. `universe` is fixed tickers.
  `universe_lists` names Robinhood curated lists (the example uses "Daily movers" and "Trending
  stocks"). At precheck, the US stocks on those lists join the universe, up to 60, and stay frozen
  for the session. Research then keeps the tradeable ones priced at or above `min_price_usd` and
  ranks them by pre-open move. An unknown list name fails precheck.

Review every other setting (see [Configuration](#configuration)).

```bash
./bin/fifty doctor --date 2026-09-30
```

`doctor` is read-only: `tools/list` plus read tools only, and the client cannot reach
place/cancel. It checks:
- the sign-in and token file;
- the account (`agentic_allowed`, type, state);
- buying power, existing positions and open orders;
- tradability and fractional eligibility of the universe, and quotes;
- schema drift against the pinned tool dump;
- power and sleep state, and launchd.

```bash
./bin/fifty simulate-session --date 2026-09-30
```

This is a full session against the simulated broker: the same engine and client code, a fake
clock, no network.

**Optional: model review.** Set `model.decider` to `"claude"` and store a key in the login
Keychain. The key is never written to a file:

```bash
security add-generic-password -a "$USER" -s fifty-anthropic -w
```

## Running a live session (you do this)

```bash
./bin/fifty arm-session --date 2026-09-30
```

Arming prints the exact scope before anything happens:
- the account (masked) and capital;
- asset scope and universe;
- session times, including early closes;
- the exit policy and the infrastructure spend cap.

You type `ARM 2026-09-30` to confirm. Arming then:
1. freezes a copy of the config and its sha256 in `state/armed.json`;
2. installs `~/Library/LaunchAgents/com.fifty.session.plist`;
3. starts the agent.

The runner sleeps until 30 minutes before the open. Later edits to `config/fifty.json` are
ignored; the armed copy is what runs.

`arm-session` also prints a `sudo pmset schedule wake ...` line. Run it if the Mac might be
asleep at precheck time. A sleeping Mac cannot trade.

| Command | Effect |
|---|---|
| `fifty status` | Phase, flags, holdings, P&L, open orders, model spend, launchd state, staleness warning |
| `fifty pause` / `fifty resume` | Stop / allow new entries. Exits and monitoring continue |
| `fifty stop` | Kill switch: no new entries for the rest of the session, entry orders cancelled. Positions still managed by their stops, targets and the wind-down |
| `fifty stop --flatten` | Kill switch plus sell every experiment position now |
| `fifty report [--date D]` | Final report (`state/sessions/D/report.md`), or an interim one mid-session |
| `fifty disarm` | Remove `armed.json` and the launchd agent |

Logs: `state/logs/runner.log` and `state/sessions/<date>/journal.jsonl` (every decision, intent,
broker update and error).

## Controls enforced in code

| Control | Where |
|---|---|
| Exactly one account, which must be `agentic_allowed`, active and not deactivated. Every call carrying another `account_number` is refused before the wire | `Robinhood.verifyAccount`, `Robinhood.call` |
| Tool allowlist: the 8 read tools, plus `place_equity_order`/`cancel_equity_order` for the runner only. No transfer, deposit, options, crypto or watchlist tool is reachable | `Robinhood` constructor |
| Spend is capped at the lower of two figures, minus `cash_reserve_usd`: (1) experiment cash = $50 + realized P&L − open cost − reserved; (2) the broker's live `buying_power`. No top-ups, no borrowing | `guard.spendable` |
| One entry order in flight at a time, so concurrent buys cannot overspend | `guard.checkEntry` |
| Long only. Sells never exceed what the experiment bought or what the broker says is sellable. Holdings that predate the session are recorded as a baseline and never sold | `guard.sizeExit`, precheck baseline |
| Equities only, regular hours only. Options and crypto are refused by config validation | `config.ts` |
| Stale, crossed, zero or wide quotes are refused (`quote_max_age_seconds`, `max_spread_pct`). Halted, untradeable or wrong-account-type symbols are refused | `guard.quoteProblem`, `checkEntry` |
| New entries pause on any uncertainty: broker unreachable, expired sign-in, position mismatch, unknown order outcome, or a foreign open agentic order | `guard.entryBlock`, `Engine.reconcile` |
| The order intent is fsync'd before it is sent. A timeout never triggers a blind retry: code first looks for exactly one matching unclaimed broker order, then resends at most once with the same `ref_id` (Robinhood deduplicates on it), then declares the order lost and alerts | `Engine.submit`, `Engine.resolveUnknown` |
| One runner per state directory (pid lock) | `acquireRunnerLock` |
| Kill switch and pause (control files, checked every tick) | `Engine.step` |
| Model: no tools, never sees credentials or the account number, can only reduce size or raise a stop. It is capped by `model.max_calls` and `boundaries.model_spend_limit_usd` | `decider/claude.ts`, `Engine.enter` |
| Frozen config: the runner uses the armed copy, and `session.json` refuses to resume under a different armed sha | `cli.ts run`, `Engine` constructor |

**Protective orders.** With `broker_stop_orders`, every whole-share position gets a broker-side
`stop_market` sell (gfd), and it keeps working if this Mac or process dies.

Fractional shares can't have stop orders: the real tool schema allows fractional quantities only
on market orders. Their stop and target are **local**, so they stop working when the process,
the Mac or the network is down.

`prefer_whole_shares` (default on) buys whole shares with a marketable limit order whenever at
least one fits, so the broker stop covers them.

## Configuration

**Boundaries.** Frozen at arming; nothing at runtime can change them:
- `account_number`
- `initial_capital_usd`
- `asset_classes`
- `model_spend_limit_usd`
- `cash_reserve_usd`

**Strategy settings.** Explicit, yours to set, and also frozen at arming:
- **Sizing:** `position_size_pct`, `max_open_positions`
- **Frequency:** `max_entries_per_session`, `min_seconds_between_entries`
- **Exits:** `stop_loss_pct`, `take_profit_pct`
- **Opening range:** `opening_range_minutes`, `breakout_buffer_pct`, `watchlist_size`
- **Session timing:** the `session.*` minutes
- **Execution:** `execution.*`

**Example strategy (`opening-range-breakout`)** is for software testing and evaluation:
1. Before the open, it ranks the universe by pre-open move.
2. It records each watchlist symbol's high and low for the first N minutes.
3. It buys a break above the range high.
4. The stop is the range low (or `stop_loss_pct`), the target is `take_profit_pct`, and the time
   exit is the wind-down.

Its weaknesses are written in `src/strategy/orb.ts`: polled ranges, adverse breakout slippage, no
shown edge. To replace it, implement the `Strategy` interface in `src/strategy/types.ts`.

## Verified vs not verified

**Verified against the real Robinhood server (read-only, 2026-09-29):**
- The OAuth sign-in works with the existing stored token.
- `tools/list` lists all 8 tools Fifty uses.
- These real responses parse correctly through the product parsers:
  - `get_accounts`: one agentic account ••••6993, `limited_margin`, active;
  - `get_portfolio`: buying power $50.00;
  - `get_equity_positions`: empty;
  - `get_equity_orders`: empty;
  - `get_equity_quotes` and `get_equity_tradability`, for real symbols.
- An unknown symbol is dropped, not zero-filled.

**Previewed with Robinhood's own pre-trade check (`review_equity_order`, 2026-09-29, nothing placed).**
All four order shapes Fifty sends were accepted with no alerts:
- the dollar-amount market buy;
- the whole-share marketable limit buy;
- the `stop_market` protective sell;
- the fractional market sell.

**Verified in simulation only.** The simulated server enforces the real input schemas and answers
in the real output shapes. 43 tests cover:
- wrong account and overspending;
- duplicate and ambiguous submission;
- partial fills and restart recovery;
- auth expiry, network loss and stale quotes;
- holidays, DST and early closes;
- session completion;
- kill switch and continued exit management;
- baseline protection, exposure-after-close recovery, and the model spend cap.

**Not verified. No live order has ever been sent:**
- the real response to `place_equity_order` and `cancel_equity_order`. If a live order response has an
  unexpected shape, entries stop. The sell-off falls back to the broker's own position numbers,
  selling whatever is held above the pre-session baseline; this is tested in simulation;
- real fill, partial-fill and fee reporting on dollar-based and stop orders;
- that Robinhood deduplicates on `ref_id` as its tool description says;
- positions with real holdings (field shapes come from the output schema only);
- rate limits (none are documented);
- behaviour during an actual trading halt;
- how long the access and refresh tokens last across a full day. Doctor shows the access expiry;
  refresh is implemented but has not been exercised against the real server;
- the launchd agent surviving a real reboot, logout or sleep. The plist is generated and loaded by
  `arm-session`, which has not been run here;
- the Claude reviewer against the live API (no key was used). The request typechecks against the
  pinned SDK.

## Known limitations

- **Sleep:** `caffeinate -i -s` holds off idle and system sleep only on AC power. A closed lid on
  battery sleeps anyway. The runner detects the gap and reconciles when it wakes, but it cannot
  trade while asleep.
- **Cash accounts:** sale proceeds are not reusable until T+1. The broker's `buying_power`
  enforces this; reinvestment within the day needs `limited_margin`, which this account has.
- **Market orders:** fractional entries and all exits are market orders. They are protected only
  by the pre-trade spread and staleness checks.
- **Positions left overnight** are sold at the next session's open, exit-only. If that also
  fails, the report says so and you must close them in the app.
- **Calendar:** only 2026–2027 NYSE dates are included; a later year fails closed.
- **Fee estimates** use the SEC Section 31 rate ($20.60 per $1M) and FINRA TAF ($0.000195/share),
  2026 rates. The broker's reported `fees` are what the report books.
