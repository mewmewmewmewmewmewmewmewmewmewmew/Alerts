# Mew Alerts — Distill.io → LINE relay

A Google Apps Script webhook that turns Distill.io's "something changed" pings
into **precise, filtered** LINE alerts that tell you *exactly* what changed.

## Why this exists

Distill's webhook only sends the **current** text of the watched element
(`{{sieve_data.text}}`) plus a name, URL and timestamp. It has **no "old value"
and no diff**. The original relay just reprinted the whole current blob, so you
couldn't see what changed and every ping became a message.

This version makes the Apps Script remember state and do the work:

| Problem (before)                     | Fix (now)                                             |
| ------------------------------------ | ----------------------------------------------------- |
| Dumps the entire current text        | Stores the previous snapshot and shows the **diff**   |
| Can't tell what changed              | `➕ Added` / `➖ Removed` lines, or `old → new`          |
| No filtering — every ping alerts     | Include / exclude keywords + min-change threshold     |
| Repeat pings spam you                | Dedupes identical + whitespace-only changes           |
| A bare hit to the URL sends an alert | Ignores empty / test hits                             |
| First-ever ping alerts on nothing    | First ping just records a silent baseline             |

## Setup

1. Open the Apps Script project (script.google.com or **Extensions → Apps
   Script** from the bound Sheet) and replace the code with `Code.gs`.
2. **Project Settings ▸ Script properties** — add:
   - `LINE_TOKEN` — LINE Messaging API channel access token
   - `GROUP_ID` — the LINE group/user id to push to
   - `CONFIG` — *(optional)* JSON filter config, see below
3. **Deploy ▸ Manage deployments** — keep the existing `/exec` deployment so
   your current Distill webhook URL keeps working. (Re-deploy a new version
   after pasting the code.)
4. In the Apps Script editor, run `resetAllState` once if you want a clean
   start. The first ping from each monitor after that stores a baseline and
   sends no alert; subsequent changes are diffed against it.

## Distill webhook configuration

Point Distill's **Webhook** action at your `/exec` URL and send these params
(query params or JSON body both work):

| Param  | Value                  |
| ------ | ---------------------- |
| `name` | `{{sieve.name}}`       |
| `text` | `{{sieve_data.text}}`  |
| `uri`  | `{{sieve.uri}}`        |
| `ts`   | `{{sieve_data.ts}}`    |

> Tip: the more precisely your Distill **selector** targets just the value you
> care about (a price, a stock label, a list), the cleaner the diff. Broad
> selectors that grab a whole page produce noisy diffs.

## Filtering (`CONFIG` script property)

Optional. A JSON object with a global `default` block and optional per-monitor
overrides keyed by the exact Distill monitor name.

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

- **`include`** — if set, an alert is sent only when a changed line contains one
  of these keywords (case-insensitive). Use it to alert *only* on the events you
  care about (e.g. `"in stock"`).
- **`exclude`** — changed lines containing any of these are dropped as noise
  before deciding whether to alert.
- **`minChars`** — ignore changes smaller than this many characters (kills
  trivial edits).
- **`enabled`** — set to `false` to mute a monitor without deleting it.

## Maintenance

- `resetAllState()` — run from the editor to clear all stored snapshots; each
  monitor re-baselines on its next ping.
- Logs: **Executions** tab shows every hit and why it did or didn't alert
  (`Baseline`, `No change`, `Filtered`, `Sent`, …).
