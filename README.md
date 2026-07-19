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
