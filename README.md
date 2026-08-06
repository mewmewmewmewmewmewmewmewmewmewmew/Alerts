# ポケカ Events

Tracks Pokémon-card event listings across 晴れる屋2 stores on
[Tonamel](https://tonamel.com), pushes a **LINE alert for genuinely new events
that match your filters**, and keeps a shared **event board** you and a friend
can tick off.

## How it works

```
GitHub Actions (every 30 min)          Cloudflare Worker              LINE
  Playwright opens each store   ──▶   dedupe vs. seen        ──push──▶ group
  page, captures its events            filter by rules
                                       store for the board
                                            │
                                       /events  ← board (list, K/R marks)
                                       /line    ← paste a link in chat to pin it
```

Nothing runs on your machine and nothing needs a subscription: Actions is free
for public repos, and the Worker runs on Cloudflare's free tier.

## Files

| Path                     | What it is                                             |
| ------------------------ | ------------------------------------------------------ |
| `scripts/poll.mjs`       | The poller — opens each store, extracts events, posts   |
| `scripts/stores.json`    | Which stores to watch                                   |
| `.github/workflows/poll.yml` | Schedule (every 30 min) + manual **Run workflow**   |
| `src/index.js`           | The Worker — dedupe, filter, LINE push, event board      |
| `config.json`            | Committed filter rules (overridable from the board)      |
| `wrangler.toml`          | Worker config + KV binding                               |
| `apps-script/Code.gs`    | The original Apps Script relay (historical reference)    |

## Capture: three ways in, in order

Tonamel is a JS-rendered SPA whose GraphQL API returns **403 to non-browser
callers**, so `poll.mjs` drives a real Chromium and tries, in order:

1. **Intercept the page's own API response** — the SPA's request succeeds where
   ours is refused, and carries entry deadlines and entrant counts.
2. **Issue the GraphQL request from inside the page** — same data if allowed.
3. **Scrape the rendered DOM** — titles, links and dates only.

Each run logs which path it used, plus how many events had dates and deadlines.

## Adding a store

Add an entry to `scripts/stores.json` and push:

```json
{ "name": "晴れる屋2 events @ 大宮", "org": "QB6TF", "game": "pokemon_card" }
```

`org` is the id in `tonamel.com/organization/<org>?game=<game>`. The `name` is
the key for the board and stored state — **don't rename an existing store**, or
it re-baselines and shows up twice.

## The event board (`/events`)

One chronological list: upcoming events plus today, with older ones folded into
a **Past events** section. Columns are sortable (click a header) and there's a
search box and a store/category picker. On a narrow screen the table scrolls
sideways rather than dropping columns — drag to reach Store, Spots and Entry 〆.

- **K / R marks** cycle through five states: empty (undecided) → grey −
  (not entering) → pink ✓ (entered) → green ★ (won) → dark red ✕ (lost). Stored
  server-side, so both of you see the same state from any device. Each header
  sorts by that person's state in that order, undecided first.
- **Entry 〆** shows when registration closes — pink within 3 days, **red once
  it has passed**.
- **Spots** shows entrants/capacity, refreshed every poll.
- **📌 Pinned** rows come from the LINE chat (below).

## Changing filters

Click **⚙ Filters** at the bottom of the board. Filters are a list of **rules**,
each with its own highlight colour:

| Field | Meaning |
| ----- | ------- |
| keywords | comma-separated; a title containing any of them matches this rule |
| colour | row tint + left border for events matching this rule |
| Ignore if title contains | global — always wins over every rule |

An event alerts if it matches **any** rule and no ignore keyword. Saving writes
an override into KV that takes precedence over `config.json` and applies
immediately — the board re-colours on save, and alerts use the new rules on the
next capture.

> Matching is literal substring. `学生以下限定` covers 小学生以下限定 and
> 中学生以下限定 but **not** 高校生以下限定 (that word is 高+校生+以下限定) —
> use `以下限定` to catch every age-restricted variant.

Committed defaults live in `config.json`:

```json
{
  "rules": [
    { "label": "スタートデッキ", "include": ["スタートデッキ"], "color": "#3b82f6" },
    { "label": "開封", "include": ["開封"], "color": "#FF4D9D" }
  ],
  "exclude": ["学生以下限定"],
  "minChars": 1
}
```

## Pinning links from the LINE chat

Paste any link into the group — optionally with a note and a date — and the bot
pins it to the board and replies to confirm:

```
シティリーグ抽選 締切7/26 https://example.com/raffle
```

The note becomes the title and the date becomes its deadline (`7/26`, `締切8/2`,
`8月2日`, `2026/8/2` all parse; the year is inferred). **Replies are free** — they
don't consume the monthly push quota, so this works even when alerts are capped.

One-time setup: add the `LINE_CHANNEL_SECRET` secret in Cloudflare, then in the
LINE Developers Console set the webhook URL to `https://distill-alerts.mew-860.workers.dev/line` and
enable **Use webhook**.

## Alerts and the LINE quota

The free LINE Messaging API plan allows **200 pushes/month**. When it runs out
the Worker logs `LINE FAILED (429)` and **leaves those events unseen so they
retry on the next capture** — nothing is lost, it just waits for the reset.
Everything still reaches the board meanwhile.

## Diagnostics (`/health`)

`GET /health` returns the last 50 decisions, newest first — `Baseline`,
`No new`, `Sent 3: …`, or `LINE FAILED (429): …`. This is the first place to
look when an alert didn't arrive.

## Custom domain

Add it as a **Custom Domain** on the Worker (Settings → Domains & Routes →
Add → Custom Domain), not as a hand-written DNS record: Cloudflare creates the
record and cert itself, and a manual CNAME to `*.workers.dev` is refused
(Error 1014). The domain must be in your Cloudflare account.

A custom domain maps the whole hostname to the Worker, so a bare visit to the
root redirects to `/events`; captures (POSTs, or GETs carrying `text`) are
unaffected. Afterwards repoint the `WEBHOOK_URL` repo secret and, if chat
pinning is set up, the LINE webhook URL.

## Deploying

The Worker auto-deploys from this repo (Cloudflare → Workers → connected to
Git). Secrets live in **Worker → Settings → Variables and Secrets**:
`LINE_TOKEN`, `GROUP_ID`, `LINE_CHANNEL_SECRET`. The poller needs one repo
secret, `WEBHOOK_URL`, pointing at the Worker.

From a checkout you can also run `npm run deploy`, `npm run dev`, or
`npm run tail` (live Worker logs).

## Resetting state

State lives in KV (Cloudflare → Storage → KV → `mew-state`):

| Key | Holds |
| --- | ----- |
| `linked::<store>` | URLs already alerted on — delete to re-baseline that store |
| `events::store::<store>` | The board's event records |
| `events::custom` | Chat-pinned links |
| `events::marks` | K/R checkmarks |
| `config::override` | Filters saved from the board (delete to fall back to `config.json`) |
