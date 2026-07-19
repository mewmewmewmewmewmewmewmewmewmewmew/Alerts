/**
 * Mew Alerts — Distill.io → LINE relay (robust version)
 * -----------------------------------------------------
 * Distill only sends the CURRENT text of a watched element. It has no
 * concept of "what changed". This script fixes that by:
 *   1. Remembering the previous snapshot per monitor (ScriptProperties).
 *   2. Computing the exact diff (added / removed lines, or old -> new).
 *   3. Filtering on keywords + a minimum-change threshold.
 *   4. Deduping repeat pings and ignoring whitespace-only noise.
 *   5. Never firing on an empty / test hit.
 *
 * ── Setup (Project Settings ▸ Script properties) ─────────────────────
 *   LINE_TOKEN   = your LINE Messaging API channel access token
 *   GROUP_ID     = the LINE group / user id to push to
 *   CONFIG       = (optional) JSON, see CONFIG_EXAMPLE in README
 *
 * ── Distill webhook config ───────────────────────────────────────────
 *   Method: POST (or GET). Send these query params (or JSON body):
 *     name = {{sieve.name}}
 *     text = {{sieve_data.text}}
 *     uri  = {{sieve.uri}}
 *     ts   = {{sieve_data.ts}}
 */

// ---- Tunable defaults (overridable per-monitor via the CONFIG property) ----
var DEFAULTS = {
  include:  [],   // if non-empty, alert ONLY when a changed line contains one of these (case-insensitive)
  exclude:  [],   // changed lines containing any of these are dropped as noise
  minChars: 1,    // ignore changes smaller than this many characters
  enabled:  true  // set false to mute a monitor without deleting it
};

function doPost(e) {
  var props = PropertiesService.getScriptProperties();

  // 1. Extract the incoming payload (query params first, JSON body as fallback).
  var incoming = readPayload(e);
  if (!incoming.hasData) {
    // Bare / test hit with no real content — do nothing, don't spam LINE.
    return ContentService.createTextOutput("No data");
  }

  var name = incoming.name || "Mew Monitor";
  var text = (incoming.text || "").toString();
  var uri  = incoming.uri  || "";
  var ts   = incoming.ts   || "";

  // 2. Serialize state access so concurrent changes can't corrupt the store.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (lockErr) {
    console.log("Lock timeout: " + lockErr);
    return ContentService.createTextOutput("Busy");
  }

  try {
    var cfg = configFor(props, name);
    if (cfg.enabled === false) {
      return ContentService.createTextOutput("Muted");
    }

    var stateKey = "state::" + name;
    var oldText  = props.getProperty(stateKey);

    // 3. First time we've seen this monitor: just record the baseline.
    if (oldText === null) {
      saveState(props, stateKey, text);
      console.log("Baseline stored for '" + name + "' (no alert on first sight)");
      return ContentService.createTextOutput("Baseline");
    }

    // 4. Dedupe: identical payload => nothing changed.
    if (normalize(oldText) === normalize(text)) {
      return ContentService.createTextOutput("No change");
    }

    // 5. Compute what actually changed.
    var diff = computeDiff(oldText, text);

    // 6. Apply exclude filter (drop noisy lines), then include filter.
    diff = applyFilters(diff, cfg);

    // Persist the new snapshot regardless of whether we alert — otherwise a
    // filtered-out change would re-diff forever.
    saveState(props, stateKey, text);

    if (!diff.meaningful) {
      console.log("Change for '" + name + "' filtered out (below threshold / excluded / not matched)");
      return ContentService.createTextOutput("Filtered");
    }

    // 7. Build and send the message.
    var message = buildMessage(name, uri, ts, diff);
    sendToLine(props, message);
    return ContentService.createTextOutput("Sent");

  } finally {
    lock.releaseLock();
  }
}

function doGet(e) { return doPost(e); }

// ────────────────────────────────────────────────────────────────────────────
// Payload parsing
// ────────────────────────────────────────────────────────────────────────────
function readPayload(e) {
  var out = { name: "", text: "", uri: "", ts: "", hasData: false };
  if (!e) return out;

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] != null && obj[keys[i]] !== "") return obj[keys[i]];
    }
    return "";
  }

  // Query params (what the current Distill setup uses).
  if (e.parameter) {
    out.name = pick(e.parameter, ["name", "sieve.name"]);
    out.text = pick(e.parameter, ["text", "sieve_data.text"]);
    out.uri  = pick(e.parameter, ["uri", "sieve.uri"]);
    out.ts   = pick(e.parameter, ["ts", "sieve_data.ts"]);
  }

  // JSON body fallback.
  if ((!out.text) && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      out.name = out.name || pick(body, ["name", "sieve.name"]);
      out.text = out.text || pick(body, ["text", "sieve_data.text"]);
      out.uri  = out.uri  || pick(body, ["uri", "sieve.uri"]);
      out.ts   = out.ts   || pick(body, ["ts", "sieve_data.ts"]);
    } catch (err) {
      console.log("JSON parse error: " + err);
    }
  }

  // Real data = we actually got some text to compare.
  out.hasData = (out.text && out.text.toString().trim().length > 0);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Diffing
// ────────────────────────────────────────────────────────────────────────────
function normalize(s) {
  return (s || "").replace(/\r/g, "").replace(/[ \t]+/g, " ")
    .split("\n").map(function (l) { return l.trim(); }).join("\n")
    .replace(/\n{2,}/g, "\n").trim();
}

function toLines(s) {
  return normalize(s).split("\n").map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0; });
}

/**
 * Returns { type, added:[], removed:[], oldVal, newVal }.
 * - "single": one line -> one line (price / status style) => oldVal -> newVal
 * - "list":   multi-line, reports added & removed lines (multiset diff)
 */
function computeDiff(oldText, newText) {
  var oldLines = toLines(oldText);
  var newLines = toLines(newText);

  if (oldLines.length <= 1 && newLines.length <= 1) {
    return {
      type: "single",
      oldVal: oldLines.join(" ") || "(empty)",
      newVal: newLines.join(" ") || "(empty)",
      added: newLines,
      removed: oldLines
    };
  }

  var oldCount = countLines(oldLines);
  var added = newLines.filter(function (l) {
    if (oldCount[l] > 0) { oldCount[l]--; return false; }
    return true;
  });

  var newCount = countLines(newLines);
  var removed = oldLines.filter(function (l) {
    if (newCount[l] > 0) { newCount[l]--; return false; }
    return true;
  });

  return { type: "list", added: added, removed: removed };
}

function countLines(lines) {
  var c = {};
  lines.forEach(function (l) { c[l] = (c[l] || 0) + 1; });
  return c;
}

// ────────────────────────────────────────────────────────────────────────────
// Filtering
// ────────────────────────────────────────────────────────────────────────────
function applyFilters(diff, cfg) {
  var exclude = (cfg.exclude || []).map(lc);
  var include = (cfg.include || []).map(lc);

  function keep(line) {
    var L = lc(line);
    if (exclude.length && exclude.some(function (k) { return L.indexOf(k) !== -1; })) return false;
    return true;
  }

  diff.added   = (diff.added   || []).filter(keep);
  diff.removed = (diff.removed || []).filter(keep);

  // Include filter: at least one changed line must match one keyword.
  if (include.length) {
    var pool = diff.added.concat(diff.removed).map(lc).join("\n");
    var matched = include.some(function (k) { return pool.indexOf(k) !== -1; });
    if (!matched) { diff.meaningful = false; return diff; }
  }

  var changedChars = (diff.type === "single")
    ? lc(diff.newVal).length
    : diff.added.concat(diff.removed).join("").length;
  var hasChange = (diff.added.length + diff.removed.length) > 0;
  diff.meaningful = hasChange && changedChars >= (cfg.minChars || 1);
  return diff;
}

function lc(s) { return (s || "").toString().toLowerCase(); }

// ────────────────────────────────────────────────────────────────────────────
// Message building
// ────────────────────────────────────────────────────────────────────────────
function buildMessage(name, uri, ts, diff) {
  var lines = ["🐱 Mew Alert!", ""];
  lines.push("📅 " + name);
  if (uri) lines.push("🔗 " + uri);
  if (ts)  lines.push("🕒 " + ts);
  lines.push("");

  if (diff.type === "single") {
    lines.push("✏️ Changed");
    lines.push(truncate(diff.oldVal, 300) + "  →  " + truncate(diff.newVal, 300));
  } else {
    if (diff.added.length) {
      lines.push("➕ Added (" + diff.added.length + ")");
      diff.added.slice(0, 15).forEach(function (l) { lines.push("• " + truncate(l, 200)); });
      if (diff.added.length > 15) lines.push("…and " + (diff.added.length - 15) + " more");
      lines.push("");
    }
    if (diff.removed.length) {
      lines.push("➖ Removed (" + diff.removed.length + ")");
      diff.removed.slice(0, 15).forEach(function (l) { lines.push("• " + truncate(l, 200)); });
      if (diff.removed.length > 15) lines.push("…and " + (diff.removed.length - 15) + " more");
    }
  }

  var msg = lines.join("\n").trim();
  return truncate(msg, 4900); // LINE hard limit is 5000 chars per text message.
}

function truncate(s, n) {
  s = (s || "").toString();
  return s.length > n ? s.substring(0, n - 1) + "…" : s;
}

// ────────────────────────────────────────────────────────────────────────────
// State + config
// ────────────────────────────────────────────────────────────────────────────
function saveState(props, key, text) {
  // ScriptProperties values are capped at 9KB. Guard against oversized snapshots.
  var v = text || "";
  if (v.length > 9000) v = v.substring(0, 9000);
  try {
    props.setProperty(key, v);
  } catch (err) {
    console.log("saveState error for " + key + ": " + err);
  }
}

function configFor(props, name) {
  var cfg = {};
  for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];

  var raw = props.getProperty("CONFIG");
  if (!raw) return cfg;

  try {
    var parsed = JSON.parse(raw);
    // Global defaults block.
    if (parsed["default"]) merge(cfg, parsed["default"]);
    // Per-monitor override (exact name match).
    if (parsed.monitors && parsed.monitors[name]) merge(cfg, parsed.monitors[name]);
  } catch (err) {
    console.log("CONFIG parse error: " + err);
  }
  return cfg;
}

function merge(base, over) {
  for (var k in over) base[k] = over[k];
}

// ────────────────────────────────────────────────────────────────────────────
// LINE delivery
// ────────────────────────────────────────────────────────────────────────────
function sendToLine(props, messageText) {
  var token = props.getProperty("LINE_TOKEN");
  var to    = props.getProperty("GROUP_ID");
  if (!token || !to) {
    console.log("Missing LINE_TOKEN or GROUP_ID — cannot send.");
    return;
  }

  var resp = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    payload: JSON.stringify({ to: to, messages: [{ type: "text", text: messageText }] }),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  if (code !== 200) {
    console.log("LINE push failed (" + code + "): " + resp.getContentText());
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Utilities for manual maintenance (run from the Apps Script editor)
// ────────────────────────────────────────────────────────────────────────────
/** Wipe all stored snapshots — next ping from each monitor becomes a fresh baseline. */
function resetAllState() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf("state::") === 0) props.deleteProperty(k);
  });
  console.log("All monitor state cleared.");
}
