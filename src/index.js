/**
 * Mew Alerts — Distill.io → LINE relay (Cloudflare Worker)
 * --------------------------------------------------------
 * Distill only sends the CURRENT text of a watched element — no old value,
 * no diff. This Worker remembers the previous snapshot per monitor (KV),
 * computes the exact diff, filters it, and pushes a LINE message.
 *
 * Routes:
 *   /            → Distill webhook (GET or POST)
 *   /admin       → password-protected filter editor (HTML)
 *   /admin/config→ GET current effective config + detected monitors (JSON)
 *   /admin/save  → POST new filter config to KV (JSON)
 *
 * Bindings / secrets (set in Cloudflare, NOT in the repo):
 *   env.MEW_STATE      — KV namespace (snapshots + filter overrides)
 *   env.LINE_TOKEN     — LINE Messaging API channel access token   (secret)
 *   env.GROUP_ID       — LINE group/user id to push to             (secret)
 *   env.ADMIN_PASSWORD — password for the /admin page              (secret)
 *
 * config.json holds the committed default filter rules; the /admin page writes
 * a runtime override into KV that takes precedence (no redeploy needed).
 */

import seedConfig from "../config.json";

const DEFAULTS = { include: [], exclude: [], minChars: 1, enabled: true };
const CONFIG_KEY = "config::override";
const STATE_PREFIX = "state::";
const LINK_DELIM = " ||| "; // separates title and url in a linked capture
const LINKED_PREFIX = "linked::";
const DIAG_KEY = "diag::recent"; // ring buffer of recent webhook decisions

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, url);
    }
    // Manual trigger for the Tonamel poller (handy for testing): /poll
    if (url.pathname === "/poll") {
      return handlePollTrigger(request, env, url);
    }
    // Public event board + its data / management endpoints.
    if (url.pathname === "/events") return html(EVENTS_HTML);
    if (url.pathname === "/events/data") return handleEventsData(env);
    if (url.pathname === "/events/remove") return handleEventsRemove(request, env, url);
    if (url.pathname === "/events/mark") return handleEventsMark(request, env, url);
    // LINE webhook: paste a link in the chat -> pinned to the event board.
    if (url.pathname === "/line") return handleLineWebhook(request, env);
    return handleWebhook(request, env);
  },

  // Cron entrypoint — polls the Tonamel GraphQL API for new matching events.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTonamelPolls(env));
  },
};

// ════════════════════════════════════════════════════════════════════════════
// Webhook (Distill → LINE)
// ════════════════════════════════════════════════════════════════════════════
async function handleWebhook(request, env) {
  try {
    const incoming = await readPayload(request);
    if (!incoming.hasData) return text("No data");

    const name = incoming.name || "Mew Monitor";
    const body = (incoming.text || "").toString();
    const uri = incoming.uri || "";
    const ts = incoming.ts || "";

    const cfgAll = await loadConfig(env);
    const cfg = pickMonitorConfig(cfgAll, name);
    if (cfg.enabled === false) return text("Muted");

    // Linked format: a Distill JavaScript selector emitting "title ||| url" per
    // line. Parse into items, filter by title, alert new ones with their link.
    if (body.includes(LINK_DELIM)) {
      return handleLinkedWebhook(env, name, body, cfg);
    }

    const key = STATE_PREFIX + name;
    const oldText = await env.MEW_STATE.get(key);

    if (oldText === null) {
      await env.MEW_STATE.put(key, cap(body));
      return text("Baseline");
    }

    if (normalize(oldText) === normalize(body)) return text("No change");

    let diff = computeDiff(oldText, body);
    diff = applyFilters(diff, cfg);

    await env.MEW_STATE.put(key, cap(body)); // advance state even if filtered

    if (!diff.meaningful) {
      await logDecision(env, name, "Filtered (diff below threshold / no keyword match)");
      return text("Filtered");
    }

    const send = await sendToLine(env, buildMessage(name, uri, ts, diff));
    if (!send.ok) {
      await logDecision(env, name, "LINE FAILED (" + send.status + "): " + send.detail);
      return text("LINE failed", 502);
    }
    await logDecision(env, name, "Sent (diff alert)");
    return text("Sent");
  } catch (err) {
    console.log("Webhook error: " + (err && err.stack ? err.stack : err));
    return text("Error", 500);
  }
}

// ── Payload parsing ─────────────────────────────────────────────────────────
async function readPayload(request) {
  const out = { name: "", text: "", uri: "", ts: "", hasData: false };
  const url = new URL(request.url);

  const pick = (getter, keys) => {
    for (const k of keys) {
      const v = getter(k);
      if (v != null && v !== "") return v;
    }
    return "";
  };
  const fromParams = (p) => (k) => p.get(k);

  const q = fromParams(url.searchParams);
  out.name = pick(q, ["name", "sieve.name"]);
  out.text = pick(q, ["text", "sieve_data.text"]);
  out.uri = pick(q, ["uri", "sieve.uri"]);
  out.ts = pick(q, ["ts", "sieve_data.ts"]);

  if (!out.text && request.method === "POST") {
    const ctype = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ctype.includes("application/json")) {
        const b = await request.json();
        const g = (k) => b[k];
        out.name = out.name || pick(g, ["name", "sieve.name"]);
        out.text = out.text || pick(g, ["text", "sieve_data.text"]);
        out.uri = out.uri || pick(g, ["uri", "sieve.uri"]);
        out.ts = out.ts || pick(g, ["ts", "sieve_data.ts"]);
      } else {
        const form = await request.formData();
        const g = fromParams(form);
        out.name = out.name || pick(g, ["name", "sieve.name"]);
        out.text = out.text || pick(g, ["text", "sieve_data.text"]);
        out.uri = out.uri || pick(g, ["uri", "sieve.uri"]);
        out.ts = out.ts || pick(g, ["ts", "sieve_data.ts"]);
      }
    } catch (err) {
      console.log("Body parse error: " + err);
    }
  }

  out.hasData = !!(out.text && out.text.toString().trim().length > 0);
  return out;
}

// ── Diffing ─────────────────────────────────────────────────────────────────
function normalize(s) {
  return (s || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function toLines(s) {
  return normalize(s)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function countLines(lines) {
  const c = Object.create(null);
  for (const l of lines) c[l] = (c[l] || 0) + 1;
  return c;
}

function computeDiff(oldText, newText) {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);

  if (oldLines.length <= 1 && newLines.length <= 1) {
    return {
      type: "single",
      oldVal: oldLines.join(" ") || "(empty)",
      newVal: newLines.join(" ") || "(empty)",
      added: newLines,
      removed: oldLines,
    };
  }

  const oldCount = countLines(oldLines);
  const added = newLines.filter((l) => {
    if (oldCount[l] > 0) { oldCount[l]--; return false; }
    return true;
  });

  const newCount = countLines(newLines);
  const removed = oldLines.filter((l) => {
    if (newCount[l] > 0) { newCount[l]--; return false; }
    return true;
  });

  return { type: "list", added, removed };
}

// ── Filtering ───────────────────────────────────────────────────────────────
function applyFilters(diff, cfg) {
  const exclude = (cfg.exclude || []).map(lc);
  const include = (cfg.include || []).map(lc);

  const notExcluded = (line) => {
    if (!exclude.length) return true;
    const L = lc(line);
    return !exclude.some((k) => L.includes(k));
  };
  const matchesInclude = (line) => {
    const L = lc(line);
    return include.some((k) => L.includes(k));
  };

  diff.added = (diff.added || []).filter(notExcluded);
  diff.removed = (diff.removed || []).filter(notExcluded);

  // A single value that itself contains an excluded keyword is dropped too.
  if (diff.type === "single" && exclude.length) {
    if (exclude.some((k) => lc(diff.newVal).includes(k))) {
      diff.meaningful = false;
      return diff;
    }
  }

  if (include.length) {
    if (diff.type === "single") {
      // Single value: gate on the value matching, keep the old → new display.
      const hay = lc(diff.newVal) + "\n" + lc(diff.oldVal);
      if (!include.some((k) => hay.includes(k))) {
        diff.meaningful = false;
        return diff;
      }
    } else {
      // List: show ONLY the added lines that match (the "hits"); drop the
      // noisy removed dump. An alert fires only when a matching line appears.
      diff.added = diff.added.filter(matchesInclude);
      diff.removed = [];
      diff.matched = true;
    }
  }

  const changedChars =
    diff.type === "single"
      ? lc(diff.newVal).length
      : diff.added.concat(diff.removed).join("").length;
  const hasChange = diff.added.length + diff.removed.length > 0;
  diff.meaningful = hasChange && changedChars >= (cfg.minChars || 1);
  return diff;
}

function lc(s) { return (s || "").toString().toLowerCase(); }

// ── Message building ────────────────────────────────────────────────────────
function buildMessage(name, uri, ts, diff) {
  const lines = ["🐱 Mew Alert!", "", "📅 " + name];
  if (uri) lines.push("🔗 " + uri);
  if (ts) lines.push("🕒 " + ts);
  lines.push("");

  if (diff.type === "single") {
    lines.push("✏️ Changed");
    lines.push(truncate(diff.oldVal, 300) + "  →  " + truncate(diff.newVal, 300));
  } else {
    if (diff.added.length) {
      lines.push((diff.matched ? "🎯 Matches (" : "➕ Added (") + diff.added.length + ")");
      diff.added.slice(0, 15).forEach((l) => lines.push("• " + truncate(l, 200)));
      if (diff.added.length > 15) lines.push("…and " + (diff.added.length - 15) + " more");
      lines.push("");
    }
    if (diff.removed.length) {
      lines.push("➖ Removed (" + diff.removed.length + ")");
      diff.removed.slice(0, 15).forEach((l) => lines.push("• " + truncate(l, 200)));
      if (diff.removed.length > 15) lines.push("…and " + (diff.removed.length - 15) + " more");
    }
  }

  return truncate(lines.join("\n").trim(), 4900);
}

function truncate(s, n) {
  s = (s || "").toString();
  return s.length > n ? s.substring(0, n - 1) + "…" : s;
}

// ── Linked capture (title ||| url [||| date] lines from a Distill JS selector)
function parseLinkedItems(body) {
  return (body || "")
    .split(/\r?\n/)
    .map((line) => {
      if (!line.includes(LINK_DELIM)) return null;
      const parts = line.split(LINK_DELIM).map((p) => p.trim());
      const title = parts[0];
      const url = parts[1];
      const date = parts[2] || "";
      const deadline = parts[3] || ""; // entry/registration closes
      const spots = parts[4] || ""; // "29/30"
      if (!title || !url) return null;
      return { title, url, date, deadline, spots };
    })
    .filter(Boolean);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

async function handleLinkedWebhook(env, name, body, cfg) {
  // Best-effort concurrency guard: Distill sometimes posts the same check
  // twice within a second; both could read the seen-set before either writes
  // it and double-send. Skipped posts lose nothing — unseen events are caught
  // on the next check. (KV TTL minimum is 60s.)
  const lockKey = "lock::" + name;
  if (await env.MEW_STATE.get(lockKey)) return text("Busy");
  await env.MEW_STATE.put(lockKey, "1", { expirationTtl: 60 });

  // Some pages render the list more than once (responsive/duplicate DOM), so
  // dedupe by URL before doing anything else.
  const items = dedupeByUrl(parseLinkedItems(body));
  const inc = (cfg.include || []).map(lc);
  const exc = (cfg.exclude || []).map(lc);
  const matching = items.filter((it) => matchTitle(it.title, inc, exc));

  // Keep the event board up to date with everything captured (not just matches).
  await upsertStoreEvents(env, name, items, new Set(matching.map((it) => it.url)));

  const key = LINKED_PREFIX + name;
  const raw = await env.MEW_STATE.get(key);
  const isBaseline = raw === null;

  let seenSet = new Set();
  if (!isBaseline) {
    try { seenSet = new Set(JSON.parse(raw) || []); } catch (e) { seenSet = new Set(); }
  }

  const fresh = matching.filter((it) => !seenSet.has(it.url));

  // Accumulate seen URLs — never shrink. A flaky/partial capture (the cloud
  // render is timing-sensitive, and the API window is "last 20") must not make
  // an event that dropped out and came back look new again. Cap to bound size.
  const persistSeen = async () => {
    for (const it of matching) seenSet.add(it.url);
    let merged = Array.from(seenSet);
    if (merged.length > 5000) merged = merged.slice(merged.length - 5000);
    await env.MEW_STATE.put(key, JSON.stringify(merged));
  };

  if (isBaseline) {
    await persistSeen();
    await logDecision(env, name, "Baseline (" + matching.length + " matching of " + items.length + ")");
    return text("Baseline");
  }

  if (!fresh.length) {
    await logDecision(env, name, "No new (" + matching.length + " matching of " + items.length + ")");
    return text("No new");
  }

  // Send FIRST; only mark events as seen if LINE accepted the message.
  // A failed push (e.g. 429 monthly quota) leaves them unseen so the next
  // check retries instead of silently losing the alert forever.
  const send = await sendToLine(env, buildLinkedMessage(name, fresh));
  if (!send.ok) {
    await logDecision(env, name,
      "LINE FAILED (" + send.status + ") for " + fresh.length + " new: " + send.detail + " — will retry next check");
    // 200, not 5xx: a 5xx makes Distill re-fire the webhook, which just spams
    // the quota-limited API. Our own retry happens on the next check anyway.
    return text("LINE failed (will retry next check)");
  }

  await persistSeen();
  await logDecision(env, name, "Sent " + fresh.length + ": " + fresh.map((it) => it.title).join(" / ").slice(0, 300));
  return text("Sent " + fresh.length);
}

function buildLinkedMessage(name, items) {
  const header = "🐱 Mew Alert! — new event" + (items.length > 1 ? "s (" + items.length + ")" : "");
  const lines = [header, "", "📅 " + name, ""];
  items.slice(0, 10).forEach((it) => {
    lines.push("🎯 " + truncate(it.title, 200));
    const meta = [];
    if (it.date) meta.push("🗓 " + truncate(it.date, 100));
    if (it.deadline) meta.push("〆 " + truncate(it.deadline, 100));
    if (it.spots) meta.push("👥 " + truncate(it.spots, 20));
    if (meta.length) lines.push(meta.join("   "));
    lines.push("🔗 " + it.url);
    lines.push("");
  });
  if (items.length > 10) lines.push("…and " + (items.length - 10) + " more");
  return truncate(lines.join("\n").trim(), 4900);
}

// ── LINE delivery ───────────────────────────────────────────────────────────
async function sendToLine(env, messageText) {
  if (!env.LINE_TOKEN || !env.GROUP_ID) {
    console.log("Missing LINE_TOKEN or GROUP_ID — cannot send.");
    return { ok: false, status: 0, detail: "missing LINE_TOKEN or GROUP_ID" };
  }
  let resp;
  try {
    resp = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.LINE_TOKEN,
      },
      body: JSON.stringify({ to: env.GROUP_ID, messages: [{ type: "text", text: messageText }] }),
    });
  } catch (err) {
    console.log("LINE push network error: " + err);
    return { ok: false, status: 0, detail: "network: " + err };
  }
  if (resp.status !== 200) {
    const body = (await resp.text()).slice(0, 300);
    console.log("LINE push failed (" + resp.status + "): " + body);
    return { ok: false, status: resp.status, detail: body };
  }
  return { ok: true, status: 200, detail: "" };
}

// ── Diagnostics: ring buffer of recent decisions, readable at /admin/health ──
async function logDecision(env, name, msg) {
  try {
    let list = [];
    try { list = JSON.parse((await env.MEW_STATE.get(DIAG_KEY)) || "[]"); } catch (e) { list = []; }
    list.unshift({ at: new Date().toISOString(), name: name, msg: msg });
    if (list.length > 50) list = list.slice(0, 50);
    await env.MEW_STATE.put(DIAG_KEY, JSON.stringify(list));
  } catch (err) {
    console.log("logDecision error: " + err);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Config (seed from config.json, overridden by KV)
// ════════════════════════════════════════════════════════════════════════════
async function loadConfig(env) {
  let override = {};
  try {
    const raw = await env.MEW_STATE.get(CONFIG_KEY);
    if (raw) override = JSON.parse(raw);
  } catch (err) {
    console.log("Config override parse error: " + err);
  }
  return mergeConfig(seedConfig, override);
}

function mergeConfig(base, over) {
  const out = {
    default: { ...(base && base.default) },
    monitors: { ...(base && base.monitors) },
    tonamel: base && base.tonamel ? base.tonamel : undefined,
  };
  if (over && over.default) Object.assign(out.default, over.default);
  if (over && over.monitors) {
    for (const k of Object.keys(over.monitors)) out.monitors[k] = over.monitors[k];
  }
  if (over && over.tonamel) out.tonamel = over.tonamel;
  return out;
}

function pickMonitorConfig(cfgAll, name) {
  const c = { ...DEFAULTS, ...(cfgAll.default || {}) };
  if (cfgAll.monitors && cfgAll.monitors[name]) Object.assign(c, cfgAll.monitors[name]);
  return c;
}

// ════════════════════════════════════════════════════════════════════════════
// Admin page
// ════════════════════════════════════════════════════════════════════════════
async function handleAdmin(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return text("Admin disabled: set the ADMIN_PASSWORD secret to enable the filter editor.", 503);
  }

  const sub = url.pathname.slice("/admin".length) || "/";

  // The page itself is public HTML; the API endpoints below require the password.
  if (request.method === "GET" && (sub === "/" || sub === "")) {
    return html(ADMIN_HTML);
  }

  const pw =
    request.headers.get("x-admin-password") || url.searchParams.get("pw") || "";
  if (!safeEqual(pw, env.ADMIN_PASSWORD)) {
    return json({ error: "unauthorized" }, 401);
  }

  if (request.method === "GET" && sub === "/config") {
    const config = await loadConfig(env);
    const monitors = await listMonitors(env);
    return json({ config, monitors });
  }

  if (request.method === "GET" && sub === "/health") {
    let recent = [];
    try { recent = JSON.parse((await env.MEW_STATE.get(DIAG_KEY)) || "[]"); } catch (e) { recent = []; }
    return json({ recent });
  }

  if (request.method === "POST" && sub === "/save") {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return json({ error: "invalid JSON" }, 400);
    }
    const clean = sanitizeConfig(body);
    if (!clean) return json({ error: "invalid config shape" }, 400);
    await env.MEW_STATE.put(CONFIG_KEY, JSON.stringify(clean));
    return json({ ok: true, config: clean });
  }

  return json({ error: "not found" }, 404);
}

async function listMonitors(env) {
  const names = new Set();
  try {
    for (const prefix of [STATE_PREFIX, LINKED_PREFIX]) {
      let cursor;
      do {
        const res = await env.MEW_STATE.list({ prefix, cursor });
        for (const k of res.keys) names.add(k.name.slice(prefix.length));
        cursor = res.list_complete ? undefined : res.cursor;
      } while (cursor);
    }
  } catch (err) {
    console.log("listMonitors error: " + err);
  }
  return Array.from(names).sort();
}

function sanitizeBlock(b) {
  const o = {};
  const arr = (v) =>
    Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 100) : [];
  if (Array.isArray(b.include)) o.include = arr(b.include);
  if (Array.isArray(b.exclude)) o.exclude = arr(b.exclude);
  if (typeof b.minChars === "number" && isFinite(b.minChars)) {
    o.minChars = Math.max(0, Math.floor(b.minChars));
  }
  if (typeof b.enabled === "boolean") o.enabled = b.enabled;
  return o;
}

function sanitizeConfig(body) {
  if (!body || typeof body !== "object") return null;
  const out = { default: {}, monitors: {} };
  if (body.default && typeof body.default === "object") out.default = sanitizeBlock(body.default);
  if (body.monitors && typeof body.monitors === "object") {
    for (const name of Object.keys(body.monitors).slice(0, 200)) {
      const blk = body.monitors[name];
      if (typeof name === "string" && name.length <= 200 && blk && typeof blk === "object") {
        out.monitors[name] = sanitizeBlock(blk);
      }
    }
  }
  return out;
}

function safeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function cap(s) {
  s = (s || "").toString();
  return s.length > 24000 ? s.substring(0, 24000) : s;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": "no-store",
    },
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Tonamel poller — queries the GraphQL API directly for new matching events.
// Configured via the "tonamel" block in config.json. Runs on the cron trigger
// (see wrangler.toml) and can be fired manually via GET /poll?key=ADMIN_PASSWORD.
// ════════════════════════════════════════════════════════════════════════════
const TONAMEL_ENDPOINT = "https://tonamel.com/graphql/competition_management";
// Exact query the site sends (proven to be accepted by the endpoint).
const TONAMEL_QUERY = `query getOrganizationGameCompetitions($organizationId: ID!, $gameId: ID!, $filter: CompetitionsFilter!) {
  organization(id: $organizationId) {
    id
    game(id: $gameId) {
      game { id __typename }
      competitions(filter: $filter) {
        edges { cursor node { ...CompetitionFragment __typename } __typename }
        pageInfo { startCursor endCursor hasNextPage hasPreviousPage __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment CompetitionFragment on Competition {
  id
  title
  status
  useMultiPhaseTournament
  entryMenus {
    id
    status
    participantChosenNum
    countSummary { currentEntrantNum __typename }
    __typename
  }
  publicStatus
  region
  __typename
}`;

async function handlePollTrigger(request, env, url) {
  // Password-gate the manual trigger (reuse ADMIN_PASSWORD).
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_PASSWORD || !safeEqual(key, env.ADMIN_PASSWORD)) {
    return text("unauthorized", 401);
  }
  const summary = await runTonamelPolls(env);
  return json({ ok: true, ran: summary });
}

async function runTonamelPolls(env) {
  const cfgAll = await loadConfig(env);
  const t = cfgAll.tonamel;
  if (!t || t.enabled === false || !Array.isArray(t.monitors)) return [];

  const summary = [];
  for (const mon of t.monitors) {
    try {
      summary.push(await pollTonamelMonitor(env, mon));
    } catch (err) {
      console.log("Tonamel poll error for " + (mon && mon.name) + ": " + (err && err.stack ? err.stack : err));
      summary.push({ name: mon && mon.name, error: String(err) });
    }
  }
  return summary;
}

async function pollTonamelMonitor(env, mon) {
  const res = await fetchTonamelCompetitions(mon.organizationId, mon.gameId);
  if (!res.events) return { name: mon.name, error: res.error || "fetch failed (see logs)" };
  const events = res.events;

  const inc = (mon.include || []).map((s) => s.toLowerCase());
  const exc = (mon.exclude || []).map((s) => s.toLowerCase());
  const matching = events.filter((e) => matchTitle(e.title, inc, exc));

  const key = "tonamel::" + mon.organizationId + "::" + mon.gameId;
  const raw = await env.MEW_STATE.get(key);
  const currentIds = matching.map((e) => e.id);

  // First run: record a silent baseline so we don't alert on the whole list.
  if (raw === null) {
    await env.MEW_STATE.put(key, JSON.stringify(currentIds));
    console.log("Tonamel baseline for " + mon.name + " (" + matching.length + " matching)");
    return { name: mon.name, baseline: matching.length };
  }

  let seen = [];
  try { seen = JSON.parse(raw) || []; } catch (e) { seen = []; }
  const seenSet = new Set(seen);
  const fresh = matching.filter((e) => !seenSet.has(e.id));

  // Advance state regardless.
  await env.MEW_STATE.put(key, JSON.stringify(currentIds));

  if (!fresh.length) {
    console.log("Tonamel " + mon.name + ": no new matches (" + matching.length + " matching total)");
    return { name: mon.name, matching: matching.length, new: 0 };
  }

  await sendToLine(env, buildTonamelMessage(mon.name, fresh));
  console.log("Tonamel " + mon.name + ": alerted " + fresh.length + " new event(s)");
  return { name: mon.name, new: fresh.length, titles: fresh.map((e) => e.title) };
}

function matchTitle(title, inc, exc) {
  const t = (title || "").toLowerCase();
  if (exc.length && exc.some((k) => t.includes(k))) return false;
  if (inc.length && !inc.some((k) => t.includes(k))) return false;
  return true;
}

async function fetchTonamelCompetitions(orgId, gameId) {
  const payload = {
    operationName: "getOrganizationGameCompetitions",
    variables: {
      organizationId: orgId,
      gameId: gameId,
      filter: { first: 0, last: 20, before: "", after: "" },
    },
    query: TONAMEL_QUERY,
  };

  const referer = "https://tonamel.com/organization/" + orgId + "?game=" + gameId;
  let resp;
  try {
    resp = await fetch(TONAMEL_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        origin: "https://tonamel.com",
        referer: referer,
        // Many endpoints gate on the mere presence of these custom headers.
        "x-csrf-token": crypto.randomUUID().toUpperCase(),
        "x-page-view-id": crypto.randomUUID(),
        "x-page-view-location": referer,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const detail = "network: " + err;
    console.log("Tonamel " + detail);
    return { events: null, error: detail };
  }

  const bodyText = await resp.text();
  if (resp.status !== 200) {
    const detail = "HTTP " + resp.status + ": " + bodyText.slice(0, 200).replace(/\s+/g, " ");
    console.log("Tonamel fetch " + detail);
    return { events: null, error: detail };
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (e) {
    const detail = "non-JSON body: " + bodyText.slice(0, 200).replace(/\s+/g, " ");
    console.log("Tonamel " + detail);
    return { events: null, error: detail };
  }
  if (data.errors) {
    const detail = "GraphQL errors: " + JSON.stringify(data.errors).slice(0, 300);
    console.log("Tonamel " + detail);
    return { events: null, error: detail };
  }

  const edges =
    data && data.data && data.data.organization && data.data.organization.game &&
    data.data.organization.game.competitions && data.data.organization.game.competitions.edges;
  if (!Array.isArray(edges)) {
    const detail = "unexpected shape: " + bodyText.slice(0, 200).replace(/\s+/g, " ");
    console.log("Tonamel " + detail);
    return { events: null, error: detail };
  }

  const events = edges
    .map((edge) => {
      const n = (edge && edge.node) || {};
      const menu = (n.entryMenus && n.entryMenus[0]) || null;
      return {
        id: n.id,
        title: n.title || "",
        status: n.status,
        publicStatus: n.publicStatus,
        entrants: menu && menu.countSummary ? menu.countSummary.currentEntrantNum : null,
        capacity: menu ? menu.participantChosenNum : null,
      };
    })
    .filter((e) => e.id && e.publicStatus === "PUBLIC");

  return { events, error: null };
}

function buildTonamelMessage(monitorName, events) {
  const header = "🐱 Mew Alert! — new event" + (events.length > 1 ? "s (" + events.length + ")" : "");
  const lines = [header, "", "📅 " + monitorName, ""];
  events.slice(0, 10).forEach((e) => {
    lines.push("🎯 " + truncate(e.title, 200));
    if (e.entrants != null && e.capacity != null) lines.push("👥 " + e.entrants + "/" + e.capacity);
    lines.push("🔗 https://tonamel.com/competition/" + e.id);
    lines.push("");
  });
  if (events.length > 10) lines.push("…and " + (events.length - 10) + " more");
  return truncate(lines.join("\n").trim(), 4900);
}

// ════════════════════════════════════════════════════════════════════════════
// Event board — stores every captured event per store, plus custom events
// pinned by pasting links into the LINE chat. Served at /events.
// ════════════════════════════════════════════════════════════════════════════
const EVENTS_STORE_PREFIX = "events::store::";
const EVENTS_CUSTOM_KEY = "events::custom";
const MARKS_KEY = "events::marks"; // { [eventUrl]: {K: bool, R: bool} } — shared entered-state

async function upsertStoreEvents(env, name, items, matchingUrls) {
  try {
    const key = EVENTS_STORE_PREFIX + name;
    let list = [];
    try { list = JSON.parse((await env.MEW_STATE.get(key)) || "[]"); } catch (e) { list = []; }
    const byUrl = new Map(list.map((e) => [e.url, e]));
    const now = new Date().toISOString();
    for (const it of items) {
      const prev = byUrl.get(it.url);
      if (prev) {
        prev.title = it.title;
        if (it.date) prev.date = it.date;
        if (it.deadline) prev.deadline = it.deadline;
        if (it.spots) prev.spots = it.spots; // fill/capacity changes over time
        prev.lastSeen = now;
        prev.matched = matchingUrls.has(it.url);
      } else {
        byUrl.set(it.url, {
          title: it.title, url: it.url, date: it.date || "",
          deadline: it.deadline || "", spots: it.spots || "",
          firstSeen: now, lastSeen: now, matched: matchingUrls.has(it.url),
        });
      }
    }
    let out = Array.from(byUrl.values());
    if (out.length > 300) out = out.slice(out.length - 300);
    await env.MEW_STATE.put(key, JSON.stringify(out));
  } catch (err) {
    console.log("upsertStoreEvents error: " + err);
  }
}

async function handleEventsData(env) {
  const stores = {};
  try {
    let cursor;
    do {
      const res = await env.MEW_STATE.list({ prefix: EVENTS_STORE_PREFIX, cursor });
      for (const k of res.keys) {
        const name = k.name.slice(EVENTS_STORE_PREFIX.length);
        try { stores[name] = JSON.parse((await env.MEW_STATE.get(k.name)) || "[]"); } catch (e) { stores[name] = []; }
      }
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
  } catch (err) {
    console.log("events data error: " + err);
  }
  let custom = [];
  try { custom = JSON.parse((await env.MEW_STATE.get(EVENTS_CUSTOM_KEY)) || "[]"); } catch (e) { custom = []; }
  let marks = {};
  try { marks = JSON.parse((await env.MEW_STATE.get(MARKS_KEY)) || "{}"); } catch (e) { marks = {}; }
  return json({ custom, stores, marks });
}

// Toggle K/R "entered" checkmarks — shared state in KV so both people see it.
async function handleEventsMark(request, env, url) {
  const target = url.searchParams.get("url") || "";
  const who = url.searchParams.get("who") || "";
  const val = url.searchParams.get("val") === "1";
  if (!target || (who !== "K" && who !== "R")) return json({ error: "bad params" }, 400);

  let marks = {};
  try { marks = JSON.parse((await env.MEW_STATE.get(MARKS_KEY)) || "{}"); } catch (e) { marks = {}; }
  const m = marks[target] || {};
  m[who] = val;
  marks[target] = m;

  // Bound growth: drop oldest entries beyond 1000 urls.
  const keys = Object.keys(marks);
  if (keys.length > 1000) for (const k of keys.slice(0, keys.length - 1000)) delete marks[k];

  await env.MEW_STATE.put(MARKS_KEY, JSON.stringify(marks));
  return json({ ok: true, url: target, marks: m });
}

async function handleEventsRemove(request, env, url) {
  const pw = url.searchParams.get("pw") || request.headers.get("x-admin-password") || "";
  if (!env.ADMIN_PASSWORD || !safeEqual(pw, env.ADMIN_PASSWORD)) return json({ error: "unauthorized" }, 401);
  const target = url.searchParams.get("url") || "";
  if (!target) return json({ error: "missing url" }, 400);
  let custom = [];
  try { custom = JSON.parse((await env.MEW_STATE.get(EVENTS_CUSTOM_KEY)) || "[]"); } catch (e) { custom = []; }
  const next = custom.filter((e) => e.url !== target);
  await env.MEW_STATE.put(EVENTS_CUSTOM_KEY, JSON.stringify(next));
  return json({ ok: true, removed: custom.length - next.length });
}

// ── LINE webhook: paste a link in the chat → pinned as a custom event ───────
async function handleLineWebhook(request, env) {
  if (request.method !== "POST") return text("OK");
  const bodyText = await request.text();
  if (!env.LINE_CHANNEL_SECRET) return text("LINE_CHANNEL_SECRET not set", 503);

  const sig = request.headers.get("x-line-signature") || "";
  if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, bodyText, sig))) {
    return text("bad signature", 403);
  }

  let payload;
  try { payload = JSON.parse(bodyText); } catch (e) { return text("bad json", 400); }

  for (const ev of payload.events || []) {
    if (ev.type !== "message" || !ev.message || ev.message.type !== "text") continue;
    const txt = ev.message.text || "";
    const urls = txt.match(/https?:\/\/\S+/g) || [];
    if (!urls.length) continue;

    const note = txt.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
    const deadline = parseDeadline(note); // e.g. "締切7/26" / "8月2日" → ISO date
    let custom = [];
    try { custom = JSON.parse((await env.MEW_STATE.get(EVENTS_CUSTOM_KEY)) || "[]"); } catch (e) { custom = []; }
    let added = 0;
    const now = new Date().toISOString();
    for (const u of urls) {
      if (custom.some((e) => e.url === u)) continue;
      custom.push({ title: note || u, url: u, date: deadline || "", addedAt: now, custom: true });
      added++;
    }
    if (custom.length > 500) custom = custom.slice(custom.length - 500);
    await env.MEW_STATE.put(EVENTS_CUSTOM_KEY, JSON.stringify(custom));
    await logDecision(env, "LINE chat", "Pinned " + added + " custom event(s) from chat");

    // Reply messages are FREE (they don't count against the monthly push quota).
    if (ev.replyToken) {
      await lineReply(env, ev.replyToken,
        added > 0 ? "📌 Pinned " + added + " link" + (added > 1 ? "s" : "") + " to the event board!"
                  : "📌 Already on the board!");
    }
  }
  return text("OK");
}

// Pull a deadline out of a pinned message's note: "2026/8/2", "8/2", "8月2日".
// Year is inferred (rolls to next year if the date passed >45 days ago).
function parseDeadline(text) {
  if (!text) return null;
  let y = null, mo, d;
  let m = text.match(/(20\d{2})[\/\-年]\s*(\d{1,2})[\/\-月]\s*(\d{1,2})/);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = text.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
    if (!m) return null;
    mo = +m[1]; d = +m[2];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y == null) {
    const now = new Date();
    y = now.getFullYear();
    if (new Date(y, mo - 1, d).getTime() < now.getTime() - 45 * 86400000) y++;
  }
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

async function verifyLineSignature(secret, body, signature) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    const b64 = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(mac))));
    return safeEqual(b64, signature);
  } catch (err) {
    console.log("verifyLineSignature error: " + err);
    return false;
  }
}

async function lineReply(env, replyToken, messageText) {
  try {
    const resp = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.LINE_TOKEN },
      body: JSON.stringify({ replyToken, messages: [{ type: "text", text: messageText }] }),
    });
    if (resp.status !== 200) console.log("LINE reply failed (" + resp.status + "): " + (await resp.text()));
  } catch (err) {
    console.log("LINE reply error: " + err);
  }
}

// ── Event board HTML: compact date-sorted list, >2-month-old collapsed,
//    shared K/R entered-checkmarks. One row per event. ──────────────────────
const EVENTS_HTML =
'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Mew Events</title><style>' +
'@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap");' +
/* Mew Catalog tokens (from claude.ai/design: Mew Catalog Design System) */
':root{--pink-050:#FFF0F7;--pink-100:#FFD6E9;--pink-300:#FFA8D0;--pink-500:#FF7BB6;--pink-700:#FF4D9D;--pink-800:#C24A80;' +
'--white:#FFFFFF;--grey-050:#F8F8F9;--grey-100:#F1F1F3;--grey-200:#E4E4E8;--grey-300:#CFCFD5;--grey-400:#A7A7B0;' +
'--grey-500:#82828B;--grey-600:#5F5F67;--grey-800:#38383E;--ink:#211F22;' +
'--font-display:"Outfit","Zen Kaku Gothic New",sans-serif;' +
'--font-body:"Zen Kaku Gothic New","Hiragino Kaku Gothic ProN",sans-serif;' +
'--font-data:"IBM Plex Mono",ui-monospace,monospace}' +
'*{box-sizing:border-box}' +
'body{font-family:var(--font-body);max-width:720px;margin:0 auto;padding:20px 16px;' +
'background:var(--white);color:var(--grey-800);-webkit-font-smoothing:antialiased}' +
'h1{font-family:var(--font-display);font-size:24px;font-weight:700;color:var(--ink);' +
'margin:0 0 4px;letter-spacing:0.01em}' +
'.rule{height:2px;background:var(--pink-700);width:44px;margin:0 0 18px;border-radius:2px}' +
'.row{display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid var(--grey-200);border-left:2px solid transparent}' +
'.row.matched{border-left-color:var(--pink-300);background:var(--pink-050)}' +
'.d{flex:0 0 70px;font-family:var(--font-data);font-size:10.5px;color:var(--grey-600);white-space:nowrap}' +
'.t{flex:1;min-width:0;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
'.t a{color:var(--ink);text-decoration:none}.t a:hover{color:var(--pink-800);text-decoration:underline}' +
'.s{flex:0 0 auto;font-size:9px;font-weight:500;color:var(--grey-500);text-transform:uppercase;' +
'letter-spacing:0.08em;border:1px solid var(--grey-200);border-radius:2px;padding:2px 6px;' +
'white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis}' +
'.pin{flex:0 0 auto;font-size:11px}' +
'.dl{flex:0 0 52px;font-family:var(--font-data);font-size:10.5px;color:var(--grey-600);white-space:nowrap}' +
'.dl.soon{color:var(--pink-800)}' +
'.sp{flex:0 0 46px;font-family:var(--font-data);font-size:10.5px;color:var(--grey-400);white-space:nowrap}' +
'.ad{flex:0 0 44px;font-family:var(--font-data);font-size:10.5px;color:var(--grey-400);white-space:nowrap}' +
'.mk{flex:0 0 66px;display:flex;gap:10px}' +
'.mk label{font-family:var(--font-data);font-size:10.5px;color:var(--grey-600);cursor:pointer;' +
'user-select:none;display:flex;align-items:center;gap:3px}' +
'input[type=checkbox]{width:14px;height:14px;accent-color:var(--pink-700);cursor:pointer;margin:0}' +
'.x{flex:0 0 14px;text-align:center}' +
'.del{background:none;border:0;color:var(--grey-400);cursor:pointer;font-size:11px;padding:0}' +
'.del:hover{color:var(--pink-800)}' +
'.hdr{display:flex;align-items:center;gap:10px;padding:4px 6px;border-bottom:1px solid var(--grey-300)}' +
'.hdr span{font-family:var(--font-body);font-size:9px;font-weight:500;color:var(--grey-500);' +
'text-transform:uppercase;letter-spacing:0.14em}' +
'.hdr .sortable{cursor:pointer}.hdr .sortable:hover{color:var(--pink-800)}' +
'.hdr .on{color:var(--pink-800)}' +
'.hdr .s{border:0;padding:0;max-width:none}' +
'.bar{display:flex;gap:8px;align-items:center;margin:0 0 6px;flex-wrap:wrap}' +
'.bar input,.bar select{font-family:var(--font-body);font-size:12px;color:var(--ink);' +
'background:var(--white);border:1px solid var(--grey-300);border-radius:2px;padding:5px 7px}' +
'.bar input{flex:1;min-width:120px}' +
'details{margin-top:22px}summary{cursor:pointer;color:var(--grey-500);font-size:9px;font-weight:500;' +
'text-transform:uppercase;letter-spacing:0.14em;padding:6px 0}' +
'#status{color:var(--grey-500);font-size:11px}' +
'@media(max-width:520px){.s{display:none}.d{flex-basis:56px}}' +
'</style></head><body>' +
'<h1>Mew Events</h1><div class="rule"></div>' +
'<div class="bar" id="bar" style="display:none">' +
'<input id="q" type="text" placeholder="Filter by title\\u2026" autocomplete="off">' +
'<select id="storeSel"></select>' +
'<label style="font-size:12px;color:var(--grey-600);display:flex;align-items:center;gap:4px">' +
'<input type="checkbox" id="onlyMatch" checked>matches only</label></div>' +
'<p id="status">Loading&#8230;</p>' +
'<div class="hdr" id="hdr" style="display:none">' +
'<span class="d sortable" data-k="when">Date &#x30fb; &#x3006;</span><span class="t sortable" data-k="title">Event</span>' +
'<span class="s sortable" data-k="store">Store</span>' +
'<span class="dl sortable" data-k="deadline">Entry &#x3006;</span><span class="sp">Spots</span>' +
'<span class="ad sortable" data-k="added">Added</span>' +
'<span class="mk">K &#x30fb; R</span><span class="x"></span></div>' +
'<div id="root"></div><div id="oldwrap"></div><script>' +
'var MARKS={};var DAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];' +
'function mk(tag,cls,txt){var el=document.createElement(tag);if(cls)el.className=cls;if(txt!=null)el.textContent=txt;return el}' +
'function parseWhen(s){if(!s)return null;' +
's=String(s).split("\\u30fb")[0].replace(/[\\uff08(].*?[)\\uff09]/g,"").trim();if(!s)return null;' +
'var m=s.match(/(20\\d{2})[\\/\\u5e74]\\s*(\\d{1,2})[\\/\\u6708]\\s*(\\d{1,2})/);' +
'if(m)return new Date(+m[1],+m[2]-1,+m[3]).getTime();' +
'm=s.match(/(\\d{1,2})\\s*[\\/\\u6708]\\s*(\\d{1,2})/);' +
'if(m){var now=new Date();var y=now.getFullYear();var ts=new Date(y,+m[1]-1,+m[2]).getTime();' +
'if(ts<now.getTime()-45*86400000)ts=new Date(y+1,+m[1]-1,+m[2]).getTime();return ts}' +
'var t=Date.parse(s);return isNaN(t)?null:t}' +
'function fmtDate(ts){if(!ts)return "\\u2014";var d=new Date(ts);return (d.getMonth()+1)+"/"+d.getDate()+" "+DAYS[d.getDay()]}' +
'function shortStore(n){var p=String(n).split("@");return (p.length>1?p[p.length-1]:n).trim()}' +
'function box(u,who){var l=document.createElement("label");var c=document.createElement("input");c.type="checkbox";' +
'c.checked=!!(MARKS[u]&&MARKS[u][who]);' +
'c.onchange=function(){var v=c.checked;' +
'fetch("/events/mark?url="+encodeURIComponent(u)+"&who="+who+"&val="+(v?"1":"0"))' +
'.then(function(r){if(!r.ok){c.checked=!v;alert("save failed")}else{MARKS[u]=MARKS[u]||{};MARKS[u][who]=v}})' +
'.catch(function(){c.checked=!v;alert("save failed")})};' +
'l.appendChild(c);l.appendChild(document.createTextNode(who));return l}' +
'function fmtShort(iso){if(!iso)return "\\u2014";var t=Date.parse(iso);if(isNaN(t))return "\\u2014";' +
'var d=new Date(t);return (d.getMonth()+1)+"/"+d.getDate()}' +
'function row(e){var r=mk("div","row"+(e.matched?" matched":""));' +
'r.appendChild(mk("span","d",(e.deadline?"\\u3006 ":"")+fmtDate(e.when)));' +
'if(e.custom)r.appendChild(mk("span","pin","\\ud83d\\udccc"));' +
'var t=mk("span","t");var a=document.createElement("a");a.href=e.url;a.textContent=e.title;' +
'a.target="_blank";a.rel="noopener";a.title=e.title;t.appendChild(a);r.appendChild(t);' +
'if(e.store)r.appendChild(mk("span","s",shortStore(e.store)));' +
'var dts=parseWhen(e.deadline);' +
'var dl=mk("span","dl",dts?("\\u3006"+fmtShort(new Date(dts).toISOString())):"\\u2014");' +
'if(dts&&dts-Date.now()<3*86400000&&dts>=Date.now()-86400000)dl.classList.add("soon");' +
'r.appendChild(dl);' +
'r.appendChild(mk("span","sp",e.spots||"\\u2014"));' +
'r.appendChild(mk("span","ad",fmtShort(e.added)));' +
'var m=mk("span","mk");m.appendChild(box(e.url,"K"));m.appendChild(box(e.url,"R"));r.appendChild(m);' +
'var xs=mk("span","x");' +
'if(e.custom){var x=mk("button","del","\\u2715");' +
'x.onclick=function(){var pw=prompt("Admin password to remove:");if(!pw)return;' +
'fetch("/events/remove?pw="+encodeURIComponent(pw)+"&url="+encodeURIComponent(e.url))' +
'.then(function(r2){if(r2.ok)r.remove();else alert("unauthorized")})};xs.appendChild(x)}' +
'r.appendChild(xs);' +
'return r}' +
'var ITEMS=[];' +
'var SORT;try{SORT=JSON.parse(localStorage.getItem("mewsort"))||{k:"when",dir:1}}catch(_e){SORT={k:"when",dir:1}}' +
'function cmp(a,b){var k=SORT.k,d=SORT.dir;' +
'if(k==="title")return d*String(a.title||"").localeCompare(String(b.title||""));' +
'if(k==="store")return d*shortStore(a.store||"").localeCompare(shortStore(b.store||""));' +
'if(k==="added")return d*((a.addedTs||0)-(b.addedTs||0));' +
'if(k==="deadline"){var x=parseWhen(a.deadline)||Infinity,y=parseWhen(b.deadline)||Infinity;' +
'return (x===y)?0:d*(x-y)}' +
'return d*((a.when||0)-(b.when||0))}' +
'function render(){' +
'var q=(document.getElementById("q").value||"").toLowerCase();' +
'var st=document.getElementById("storeSel").value;' +
'var om=document.getElementById("onlyMatch").checked;' +
'var list=ITEMS.filter(function(e){' +
'if(om&&!e.matched)return false;' +
'if(st&&(e.store||"")!==st)return false;' +
'if(q&&String(e.title||"").toLowerCase().indexOf(q)===-1)return false;return true});' +
'var cutoff=Date.now()-7*86400000;' +
'var recent=list.filter(function(e){return e.when>=cutoff}).sort(cmp);' +
'var old=list.filter(function(e){return e.when<cutoff}).sort(cmp);' +
'var root=document.getElementById("root");root.innerHTML="";' +
'recent.forEach(function(e){root.appendChild(row(e))});' +
'var ow=document.getElementById("oldwrap");ow.innerHTML="";' +
'if(old.length){var det=document.createElement("details");' +
'det.appendChild(mk("summary",null,"\\ud83d\\uddc4 Past events ("+old.length+")"));' +
'old.forEach(function(e){det.appendChild(row(e))});ow.appendChild(det)}' +
'var hs=document.querySelectorAll(".hdr .sortable");' +
'for(var i=0;i<hs.length;i++){var h=hs[i];' +
'if(h.getAttribute("data-base")===null)h.setAttribute("data-base",h.textContent);' +
'var on=h.getAttribute("data-k")===SORT.k;' +
'h.textContent=h.getAttribute("data-base")+(on?(SORT.dir>0?" \\u2191":" \\u2193"):"");' +
'h.classList.toggle("on",on)}' +
'document.getElementById("status").textContent=(recent.length||old.length)?"":' +
'(ITEMS.length?"Nothing matches your filter.":"No events yet \\u2014 they appear as monitors report in.")}' +
'fetch("/events/data").then(function(r){return r.json()}).then(function(data){' +
'MARKS=data.marks||{};ITEMS=[];' +
'(data.custom||[]).forEach(function(e){var w=parseWhen(e.date);e.deadline=(w!=null);e.store="";' +
'e.when=(w!=null)?w:(Date.parse(e.addedAt)||Date.now());e.added=e.addedAt;e.addedTs=Date.parse(e.addedAt)||0;ITEMS.push(e)});' +
'Object.keys(data.stores||{}).forEach(function(n){(data.stores[n]||[]).forEach(function(e){' +
'e.store=n;var w=parseWhen(e.date);e.when=(w!=null)?w:(Date.parse(e.firstSeen)||0);' +
'e.added=e.firstSeen;e.addedTs=Date.parse(e.firstSeen)||0;ITEMS.push(e)})});' +
'var names={};ITEMS.forEach(function(e){if(e.store)names[e.store]=1});' +
'var sel=document.getElementById("storeSel");sel.appendChild(new Option("All stores",""));' +
'Object.keys(names).sort().forEach(function(n){sel.appendChild(new Option(shortStore(n),n))});' +
'document.getElementById("bar").style.display="flex";' +
'if(ITEMS.length)document.getElementById("hdr").style.display="flex";' +
'var om=document.getElementById("onlyMatch");' +
'try{var sv=localStorage.getItem("mewonly");if(sv!==null)om.checked=(sv==="1")}catch(_e){}' +
'document.getElementById("q").oninput=render;sel.onchange=render;' +
'om.onchange=function(){try{localStorage.setItem("mewonly",om.checked?"1":"0")}catch(_e){}render()};' +
'document.querySelectorAll(".hdr .sortable").forEach(function(h){h.onclick=function(){' +
'var k=h.getAttribute("data-k");if(SORT.k===k)SORT.dir=-SORT.dir;else{SORT.k=k;SORT.dir=1}' +
'try{localStorage.setItem("mewsort",JSON.stringify(SORT))}catch(_e){}render()}});' +
'render()})' +
'.catch(function(e){document.getElementById("status").textContent="Failed to load: "+e.message});' +
'</script></body></html>';

// ── Admin page HTML (self-contained; no backticks / ${} inside) ──────────────
const ADMIN_HTML =
'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>Mew Alerts — Filters</title><style>' +
'*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
'max-width:640px;margin:0 auto;padding:16px;background:#0f1115;color:#e6e6e6}' +
'h1{font-size:20px}h2{font-size:16px;margin-top:24px}' +
'.block{border:1px solid #2a2e37;border-radius:10px;padding:12px;margin:10px 0;background:#161a22}' +
'.btitle{font-weight:600;margin-bottom:8px;word-break:break-word}' +
'.row{display:flex;align-items:center;gap:8px;margin:6px 0}' +
'.row label{flex:0 0 46%;font-size:13px;color:#a9b1bd}' +
'input[type=text],input[type=number],input[type=password],select{flex:1;min-width:0;padding:8px;' +
'border:1px solid #2a2e37;border-radius:8px;background:#0f1115;color:#e6e6e6;font-size:14px}' +
'button{padding:9px 14px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}' +
'button.secondary{background:#2a2e37}.muted{color:#8a93a2;font-size:13px}' +
'#status,#savestatus{margin-left:8px;font-size:13px}.add{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}' +
'</style></head><body>' +
'<h1>🐱 Mew Alerts — Filters</h1>' +
'<div class="add"><input id="pw" type="password" placeholder="Admin password" autocomplete="current-password">' +
'<button onclick="load()">Load</button><span id="status" class="muted"></span></div>' +
'<div id="app" style="display:none">' +
'<p class="muted">“Alert ONLY if contains” = comma-separated keywords. When set, the alert fires ' +
'only when a NEW line contains one of them, and shows ONLY those matching lines (plus the link) — ' +
'no giant dump. Leave blank to show the full diff. “Ignore if contains” drops noisy lines. ' +
'Min change = ignore edits smaller than N characters.</p>' +
'<div id="blocks"></div>' +
'<h2>Add monitor override</h2>' +
'<div class="add"><select id="detected"></select><input id="newname" type="text" placeholder="or type a monitor name">' +
'<button class="secondary" onclick="addMonitor()">Add</button></div>' +
'<div class="add"><button onclick="save()">💾 Save</button><span id="savestatus"></span></div>' +
'</div><script>' +
'function setStatus(m){document.getElementById("status").textContent=m}' +
'function fieldRow(t,el){var d=document.createElement("div");d.className="row";var l=document.createElement("label");' +
'l.textContent=t;d.appendChild(l);d.appendChild(el);return d}' +
'function makeBlock(name,block){block=block||{};var wrap=document.createElement("div");wrap.className="block";' +
'var title=document.createElement("div");title.className="btitle";title.textContent=(name===null?"Default (all monitors)":name);' +
'wrap.appendChild(title);' +
'var enabled=document.createElement("input");enabled.type="checkbox";enabled.checked=(block.enabled!==false);' +
'var inc=document.createElement("input");inc.type="text";inc.value=(block.include||[]).join(", ");inc.placeholder="in stock, restock";' +
'var exc=document.createElement("input");exc.type="text";exc.value=(block.exclude||[]).join(", ");exc.placeholder="sold out, loading";' +
'var minc=document.createElement("input");minc.type="number";minc.min="0";minc.value=(block.minChars!=null?block.minChars:1);' +
'wrap.appendChild(fieldRow("Enabled",enabled));wrap.appendChild(fieldRow("Alert ONLY if contains",inc));' +
'wrap.appendChild(fieldRow("Ignore if contains",exc));wrap.appendChild(fieldRow("Min change (chars)",minc));' +
'if(name!==null){var rm=document.createElement("button");rm.className="secondary";rm.textContent="Remove override";' +
'rm.onclick=function(){wrap.remove()};var r=document.createElement("div");r.className="row";r.appendChild(rm);wrap.appendChild(r)}' +
'wrap._name=name;wrap._get=function(){var b={};' +
'var i=inc.value.split(",").map(function(s){return s.trim()}).filter(Boolean);if(i.length)b.include=i;' +
'var e=exc.value.split(",").map(function(s){return s.trim()}).filter(Boolean);if(e.length)b.exclude=e;' +
'var m=parseInt(minc.value,10);b.minChars=isNaN(m)?1:m;b.enabled=enabled.checked;return b};return wrap}' +
'function render(config,monitors){var host=document.getElementById("blocks");host.innerHTML="";' +
'host.appendChild(makeBlock(null,(config&&config.default)||{}));var mons=(config&&config.monitors)||{};' +
'Object.keys(mons).forEach(function(n){host.appendChild(makeBlock(n,mons[n]))});' +
'var sel=document.getElementById("detected");sel.innerHTML="";(monitors||[]).forEach(function(n){' +
'var o=document.createElement("option");o.value=n;o.textContent=n;sel.appendChild(o)})}' +
'function collect(){var cfg={default:{},monitors:{}};document.querySelectorAll(".block").forEach(function(bl){' +
'if(bl._name===null)cfg.default=bl._get();else cfg.monitors[bl._name]=bl._get()});return cfg}' +
'function addMonitor(){var name=(document.getElementById("newname").value||"").trim()||document.getElementById("detected").value;' +
'if(!name)return;document.getElementById("blocks").appendChild(makeBlock(name,{}));document.getElementById("newname").value=""}' +
'function load(){var pw=document.getElementById("pw").value;localStorage.setItem("mewpw",pw);setStatus("Loading…");' +
'fetch("/admin/config?pw="+encodeURIComponent(pw)).then(function(r){if(!r.ok)throw new Error("auth failed ("+r.status+")");return r.json()})' +
'.then(function(d){render(d.config,d.monitors);document.getElementById("app").style.display="block";setStatus("")})' +
'.catch(function(e){setStatus(e.message)})}' +
'function save(){var pw=localStorage.getItem("mewpw")||document.getElementById("pw").value;var cfg=collect();' +
'document.getElementById("savestatus").textContent="Saving…";' +
'fetch("/admin/save",{method:"POST",headers:{"content-type":"application/json","x-admin-password":pw},body:JSON.stringify(cfg)})' +
'.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})' +
'.then(function(res){document.getElementById("savestatus").textContent=res.ok?"Saved ✓":("Error: "+(res.j.error||"failed"))})' +
'.catch(function(e){document.getElementById("savestatus").textContent="Error: "+e.message})}' +
'window.addEventListener("load",function(){var p=localStorage.getItem("mewpw");if(p){document.getElementById("pw").value=p;load()}});' +
'</script></body></html>';
