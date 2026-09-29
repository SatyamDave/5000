# Foundation selection (2026-09-29)

All five candidate repositories were inspected from source via the GitHub API. Nothing was cloned,
installed, or run. Each was pinned at the commit shown.

| Repo | Pinned commit | License | How orders are placed | Limits enforced in code? | Tests |
|---|---|---|---|---|---|
| OpenTradeOSS/OpenTrade | `60019dd` (2026-09-29) | Elastic-2.0 | The model calls the MCP tools; a hook sends each call for app approval, instant in auto mode | No dollar or symbol caps found | 45 files |
| dylanmccavitt/agentic-trader | `d5699b9` (2026-06-13) | MIT | The model calls the tools; a PreToolUse hook gates them | Yes: account, whitelist, max $, one order per day | 9 files |
| YizhiSong/FriesTrader | `4584136` (2026-09-11) | MIT | The model calls the tools | No (advisory scripts only) | 0 |
| aditya-r123/claude-robinhood-mcp | `6d84d4b` (2026-07-02) | none | The model runs with `--dangerously-skip-permissions` | Prompt only | 0 |
| PlasmaZero/Robinhood-Agent @ `claude/robinhood-trading-mcp-SNgTg` | `ec38dac` (2026-06-05) | none | The model calls the tools | Prompt only; the dry-run blocklist uses tool names that don't exist | 0 |

**Decision: none of the five is the code base.** The broker layer comes from the owner's own
`fall_forward_labs` repository, pinned at `e29a4c5`.

**Why:**
- In all five, the model calls the order tools itself, and the limits are hooks or prompts wrapped
  around it. The spec wants the opposite: code owns every order, and the model can only propose.
- OpenTrade is the most complete of the five, but it is a heavy Electron/Bun GUI. It has telemetry
  on by default and no code-side dollar caps in auto mode.
- agentic-trader is the best of the five. But its limits live in a hook whose state file the model
  writes, and its ref_id and fill checks are driven by the prompt.
- `fall_forward_labs` already had the hardest parts working against the real server:
  - the official MCP OAuth flow (PKCE, loopback callback, `state` check);
  - token refresh serialized across processes with a file lock;
  - a 0600 token file kept outside the repo;
  - the full real `tools/list` dump, with input and output schemas.

**What was taken from fall_forward_labs:**
- `src/broker/robinhood-oauth.ts` and `src/broker/file-lock.ts`, vendored with small path and name
  edits.
- The `{data, guide}` envelope parsing and the account check.
- `docs/robinhood-tools-2026-09-29.json`.

**Two fall_forward_labs bugs found here and not carried over:**
- Orders were read from `filled_quantity`, but the real schema field is `cumulative_quantity`.
- `findOrderByRefId` matches on `ref_id`, but real order objects have no `ref_id` field, so it can
  never match.

**Ideas taken, but not code:** agentic-trader's launchd agent plus a lock. The upstream repos
contribute no code, so no upstream license notice is needed.
