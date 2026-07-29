# Mew Alerts — Distill.io → LINE relay

A **Cloudflare Worker** that turns Distill.io's "something changed" pings into
**precise, filtered** LINE alerts that tell you *exactly* what changed.

## Why this exists

Distill's webhook only sends the **current** text of the watched element
(`{{sieve_data.text}}`) plus a name, URL and timestamp. It has **no "old value"
and no diff**. The original relay just reprinted the whole current blob, so you
couldn't see what changed and every ping became a message.

This version makes the Worker the brain: it remembers state and does the work.

| Problem (before)                     | Fix (now)                                             |
| ------------------------------------ | ----------------------------------------------------- |
| Dumps the entire current text        | Stores the previous snapshot (KV) and shows the diff  |
| Can't tell what changed              | `➕ Added` / `➖ Removed` lines, or `old → new`          |
| No filtering — every ping alerts     | Include / exclude keywords + min-change threshold     |
| Repeat pings spam you                | Dedupes identical + whitespace-only changes           |
| A bare hit to the URL sends an alert | Ignores empty / test hits                             |
| First-ever ping alerts on nothing    | First ping just records a silent baseline             |

## Architecture

```
Distill (browser ext) ──HTTPS webhook──▶ Cloudflare Worker ──push──▶ LINE
                                              │
                                              ├─ KV: previous snapshot per monitor
                                              └─ config.json: filter rules (in this repo)
```

Filter rules live in **`config.json`** (committed here, so they're
version-controlled and editable via pull request). Secrets live in Cloudflare.

## Files

| Path                  | What it is                                             |
| --------------------- | ------------------------------------------------------ |
| `src/index.js`        | The Worker (payload parsing, diff, filter, LINE push)  |
| `config.json`         | Filter rules — defaults + per-monitor overrides        |
| `wrangler.toml`       | Worker config + KV binding                              |
| `apps-script/Code.gs` | Legacy Google Apps Script version (reference / fallback)|

## One-time setup

You need a free Cloudflare account. Two ways to deploy:

### Option A — Deploy from the CLI (fastest to get running)

```bash
npm install
npx wrangler login

# 1. Create the KV namespace, then paste the printed id into wrangler.toml
npx wrangler kv namespace create MEW_STATE

# 2. Store your secrets (never commit these)
npx wrangler secret put LINE_TOKEN      # paste your LINE channel access token
npx wrangler secret put GROUP_ID        # paste your LINE group/user id
npx wrangler secret put ADMIN_PASSWORD  # any strong password, for the /admin page

# 3. Ship it
npm run deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://mew-alerts.<subdomain>.workers.dev` — that's your new webhook URL.

### Option B — Auto-deploy from GitHub (no more copy-paste)

In the Cloudflare dashboard: **Workers & Pages → Create → Connect to Git**,
pick this repo. Cloudflare runs `wrangler deploy` on every push to the branch.
Then set the KV namespace + the `LINE_TOKEN` / `GROUP_ID` / `ADMIN_PASSWORD`
secrets in **Worker → Settings → Variables and Secrets**. After this, every
commit here deploys itself.

## Point Distill at the new URL

In Distill's **Webhook** action, set the URL to your Worker URL and send these
params (query params or JSON body both work):

| Param  | Value                  |
| ------ | ---------------------- |
| `name` | `{{sieve.name}}`       |
| `text` | `{{sieve_data.text}}`  |
| `uri`  | `{{sieve.uri}}`        |
| `ts`   | `{{sieve_data.ts}}`    |

> The cleaner your Distill **selector** (just the price, just the stock label),
> the cleaner the diff. Broad selectors that grab a whole page = noisy diffs.

The first ping per monitor records a silent baseline (no alert); every change
after that is diffed against it.

## Changing filters — the admin page

There are **two** ways to change filters, and they layer:

1. **`config.json`** (this repo) = the committed *defaults*. Edit + push (or ask
   Claude to) and it redeploys. Good for the baseline rules.
2. **`/admin`** = a live editor that writes a *runtime override* into KV. Changes
   take effect on the very next ping — **no redeploy**.

Open `https://mew-alerts.<subdomain>.workers.dev/admin`, enter your
`ADMIN_PASSWORD`, and you get a form (mobile-friendly) to:

- edit the **Default** rules (apply to every monitor),
- add a **per-monitor override** (it lists monitors it has already seen so you
  can pick one), toggling include/exclude keywords, min-change size, or muting.

Effective rule for a monitor = `DEFAULTS` → `config.json` default → KV override
default → `config.json` monitor → KV override monitor (later wins). To fall back
to the committed `config.json`, delete the `config::override` KV key.

> The `/admin` page HTML is public, but every read/write requires the password
> (checked server-side). Use a long random `ADMIN_PASSWORD`.

## Filter fields (`config.json` and the admin form)

A `default` block plus optional per-monitor overrides keyed by the exact Distill
monitor name:

```json
{
  "default": {
    "exclude": ["cookie", "advertisement", "loading"],
    "minChars": 2
  },
  "monitors": {
    "Sneaker Restock": {
      "include": ["in stock", "restock", "available"],
      "exclude": ["sold out"]
    },
    "Price Watch": {
      "minChars": 1
    }
  }
}
```

Fields (all optional):

- **`include`** — if set, alert only when a changed line contains one of these
  (case-insensitive). Use it to alert *only* on the events you care about.
- **`exclude`** — changed lines containing any of these are dropped as noise
  before deciding whether to alert.
- **`minChars`** — ignore changes smaller than this many characters.
- **`enabled`** — set `false` to mute a monitor without deleting it.

## GitHub Actions poller (replaces Distill — recommended)

`scripts/poll.mjs` + `.github/workflows/poll.yml` do what Distill did, for free:
a scheduled GitHub Action launches real Chromium (Playwright), opens each store
page so the request has a genuine browser context, then calls Tonamel's GraphQL
API **from inside the page** — which gets past the 403 that blocks server-side
calls. It posts `title ||| url ||| date` per store to the Worker, exactly the
format the linked-capture path already expects, so alerts, the event board,
filters and K/R marks all keep working unchanged.

Why it beats the browser-extension route: no selectors to maintain, dates come
from the API's own timestamps (`tournaments[0].displayStartAt`, formatted in
JST), no per-store UI clicking, and no monthly credits.

**Setup**
1. Repo → Settings → Secrets and variables → Actions → New repository secret:
   `WEBHOOK_URL` = your Worker base URL (e.g. `https://<worker>.workers.dev`).
2. Edit `scripts/stores.json` to list the stores to watch — each entry is
   `{ "name": "<monitor name>", "org": "<orgId>", "game": "pokemon_card" }`.
   The `name` must match the monitor name your filters use; `org` is the id in
   `tonamel.com/organization/<org>?game=…`.
3. Actions tab → **Poll Tonamel** → **Run workflow** to trigger it once, then it
   runs on the schedule (default every 30 min; edit the cron in the workflow).

Note: GitHub's scheduled runs are best-effort and can lag at busy times; the
`workflow_dispatch` button always runs immediately.

## Linked capture — per-event links via a Distill JS selector (legacy)

Tonamel's page is a JS-rendered SPA and its GraphQL API returns **403 to
non-browser IPs** (so the scheduled poller below can't reach it from Cloudflare).
The robust workaround runs the fetch where it already works — your browser —
using a Distill **JavaScript selector** that emits `title ||| url` per line:

```js
Array.from(document.querySelectorAll('li.competition-item a.nuxt-link')).map(function (a) {
  var t = a.querySelector('.title');
  return (t ? t.textContent.trim() : a.textContent.trim().split('\n')[0]) + ' ||| ' + a.href;
}).join('\n')
```

Distill posts that to the Worker like any other monitor. When the Worker sees
the ` ||| ` delimiter it parses each line into `{title, url}`, filters titles by
the monitor's `include`/`exclude` (from `config.json` / the admin page), diffs
new URLs against a `linked::<monitor name>` KV baseline, and alerts on each new
matching event **with its own link**:

```
🐱 Mew Alert! — new event

📅 晴れる屋2 events @ 秋葉原

🎯 スタートデッキ100対戦会【16時の部】
🔗 https://tonamel.com/competition/PgrEh
```

## Tonamel poller (scheduled GraphQL — parked)

> ⚠️ Disabled by default (`tonamel.enabled: false`): tonamel's edge returns a
> 403 to server-side callers, so this path only works from an allowed IP (e.g.
> via a residential proxy). Kept for reference / future use. The linked-capture
> path above is what's actually in use.

For sites whose API *is* reachable, the Worker can query GraphQL directly on a
schedule (cron in `wrangler.toml`, default every 5 min), filter by keyword on
the title, and alert on each **new** matching event with its own link and spot
count:

```
🐱 Mew Alert! — new event

📅 晴れる屋2 events @ 秋葉原

🎯 スタートデッキ100対戦会【16時の部】
👥 29/30
🔗 https://tonamel.com/competition/PgrEh
```

Configured under the `tonamel` block in `config.json`:

```json
"tonamel": {
  "enabled": true,
  "monitors": [
    {
      "name": "晴れる屋2 events @ 秋葉原",
      "organizationId": "rmQjT",
      "gameId": "pokemon_card",
      "include": ["スタートデッキ", "ボックス開封"],
      "exclude": ["小学生以下限定"]
    }
  ]
}
```

- `organizationId` / `gameId` come from the page URL
  (`tonamel.com/organization/<organizationId>?game=<gameId>`).
- `include` / `exclude` match against the event **title** (case-insensitive
  substring). Keyword matching is literal — `ボックス開封` will not match a title
  written `BOX開封`; add both spellings if you want to catch either.
- First poll records a silent baseline; after that, only genuinely new matching
  events alert. State is keyed `tonamel::<organizationId>::<gameId>` in KV.

**Test it without waiting for the cron:** `GET /poll?key=<ADMIN_PASSWORD>` runs
all Tonamel monitors immediately and returns a JSON summary of what it did.

## Event board (`/events`)

A public read-only page listing every event the monitors have captured,
grouped by store — matches highlighted, dates and links included. Backed by
`events::store::<name>` keys that update on every check.

**Pin custom events from the LINE chat:** paste any link (optionally with a
note) into the group and the bot pins it to the board's 📌 section and replies
a confirmation. Replies are free — they don't consume the monthly push quota.
Removing a pinned event (✕ on the board) asks for `ADMIN_PASSWORD`.

One-time LINE setup for chat pinning:
1. Cloudflare → Worker → add secret `LINE_CHANNEL_SECRET` (from LINE Developers
   Console → channel → Basic settings). Used to verify webhook signatures.
2. LINE Developers Console → Messaging API → set **Webhook URL** to
   `https://<worker>/line`, enable **Use webhook**.
3. In LINE Official Account Manager → Response settings: enable webhooks,
   disable auto-reply.

## Diagnostics (`/admin/health`)

`GET /admin/health?pw=<ADMIN_PASSWORD>` returns the last 50 webhook decisions
(`Baseline` / `No new` / `Sent …` / `LINE FAILED (status)…`), newest first.
Failed LINE pushes are retried on the next check — events are only marked
seen after LINE accepts the message.

## Local development & logs

```bash
npm run dev     # run the Worker locally (wrangler dev)
npm run tail    # live-stream production logs (wrangler tail)
```

Every hit logs why it did or didn't alert: `Baseline`, `No change`,
`Filtered`, `Sent`, …

## Resetting state

To re-baseline a monitor, delete its KV key (key format `state::<monitor name>`)
from the Cloudflare dashboard (**Worker → KV**) or via
`npx wrangler kv key delete --binding MEW_STATE "state::<name>"`.
