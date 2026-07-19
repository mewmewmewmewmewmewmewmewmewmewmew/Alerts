/**
 * Mew Alerts — Distill.io → LINE relay (Cloudflare Worker)
 * --------------------------------------------------------
 * Distill only sends the CURRENT text of a watched element. It has no concept
 * of "what changed". This Worker fixes that by remembering the previous
 * snapshot per monitor (in KV), computing the exact diff, filtering it, and
 * only then pushing a LINE message.
 *
 * Bindings / secrets (set in Cloudflare, NOT in the repo):
 *   env.MEW_STATE   — KV namespace (see wrangler.toml)
 *   env.LINE_TOKEN  — LINE Messaging API channel access token   (secret)
 *   env.GROUP_ID    — LINE group/user id to push to             (secret)
 *
 * Filter rules live in config.json (committed, version-controlled).
 */

import config from "../config.json";

// Per-monitor defaults; overridden by config.json.
const DEFAULTS = { include: [], exclude: [], minChars: 1, enabled: true };

export default {
  async fetch(request, env) {
    try {
      const incoming = await readPayload(request);
      if (!incoming.hasData) return text("No data");

      const name = incoming.name || "Mew Monitor";
      const body = (incoming.text || "").toString();
      const uri = incoming.uri || "";
      const ts = incoming.ts || "";

      const cfg = configFor(name);
      if (cfg.enabled === false) return text("Muted");

      const key = "state::" + name;
      const oldText = await env.MEW_STATE.get(key);

      // First sight of this monitor → store a silent baseline.
      if (oldText === null) {
        await env.MEW_STATE.put(key, cap(body));
        return text("Baseline");
      }

      // Dedupe identical / whitespace-only pings.
      if (normalize(oldText) === normalize(body)) return text("No change");

      let diff = computeDiff(oldText, body);
      diff = applyFilters(diff, cfg);

      // Always advance state, even when filtered, so it won't re-diff forever.
      await env.MEW_STATE.put(key, cap(body));

      if (!diff.meaningful) return text("Filtered");

      const message = buildMessage(name, uri, ts, diff);
      await sendToLine(env, message);
      return text("Sent");
    } catch (err) {
      console.log("Worker error: " + (err && err.stack ? err.stack : err));
      return text("Error", 500);
    }
  },
};

// ── Payload parsing ─────────────────────────────────────────────────────────
async function readPayload(request) {
  const out = { name: "", text: "", uri: "", ts: "", hasData: false };
  const url = new URL(request.url);

  const pickParams = (p, keys) => {
    for (const k of keys) {
      const v = p.get(k);
      if (v != null && v !== "") return v;
    }
    return "";
  };

  // Query params (what the current Distill setup uses).
  out.name = pickParams(url.searchParams, ["name", "sieve.name"]);
  out.text = pickParams(url.searchParams, ["text", "sieve_data.text"]);
  out.uri = pickParams(url.searchParams, ["uri", "sieve.uri"]);
  out.ts = pickParams(url.searchParams, ["ts", "sieve_data.ts"]);

  // Body fallback (JSON or form-encoded).
  if (!out.text && request.method === "POST") {
    const ctype = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ctype.includes("application/json")) {
        const b = await request.json();
        const pick = (keys) => keys.map((k) => b[k]).find((v) => v != null && v !== "") || "";
        out.name = out.name || pick(["name", "sieve.name"]);
        out.text = out.text || pick(["text", "sieve_data.text"]);
        out.uri = out.uri || pick(["uri", "sieve.uri"]);
        out.ts = out.ts || pick(["ts", "sieve_data.ts"]);
      } else {
        const form = await request.formData();
        out.name = out.name || pickParams(form, ["name", "sieve.name"]);
        out.text = out.text || pickParams(form, ["text", "sieve_data.text"]);
        out.uri = out.uri || pickParams(form, ["uri", "sieve.uri"]);
        out.ts = out.ts || pickParams(form, ["ts", "sieve_data.ts"]);
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

  const keep = (line) => {
    const L = lc(line);
    if (exclude.length && exclude.some((k) => L.includes(k))) return false;
    return true;
  };

  diff.added = (diff.added || []).filter(keep);
  diff.removed = (diff.removed || []).filter(keep);

  if (include.length) {
    const pool = diff.added.concat(diff.removed).map(lc).join("\n");
    if (!include.some((k) => pool.includes(k))) {
      diff.meaningful = false;
      return diff;
    }
  }

  // For a single value the "size of change" is the new value's length;
  // for a list it's the total text of the added/removed lines.
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
      lines.push("➕ Added (" + diff.added.length + ")");
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

  return truncate(lines.join("\n").trim(), 4900); // LINE limit is 5000 chars.
}

function truncate(s, n) {
  s = (s || "").toString();
  return s.length > n ? s.substring(0, n - 1) + "…" : s;
}

// ── Config ──────────────────────────────────────────────────────────────────
function configFor(name) {
  const cfg = { ...DEFAULTS };
  if (config && config.default) Object.assign(cfg, config.default);
  if (config && config.monitors && config.monitors[name]) Object.assign(cfg, config.monitors[name]);
  return cfg;
}

// ── LINE delivery ───────────────────────────────────────────────────────────
async function sendToLine(env, messageText) {
  if (!env.LINE_TOKEN || !env.GROUP_ID) {
    console.log("Missing LINE_TOKEN or GROUP_ID — cannot send.");
    return;
  }
  const resp = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.LINE_TOKEN,
    },
    body: JSON.stringify({ to: env.GROUP_ID, messages: [{ type: "text", text: messageText }] }),
  });
  if (resp.status !== 200) {
    console.log("LINE push failed (" + resp.status + "): " + (await resp.text()));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function cap(s) {
  // KV values are large-limit, but keep snapshots bounded for sanity.
  s = (s || "").toString();
  return s.length > 24000 ? s.substring(0, 24000) : s;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}
