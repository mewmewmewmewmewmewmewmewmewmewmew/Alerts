/**
 * Tonamel → Mew Alerts poller (replaces Distill).
 *
 * Runs a real Chromium via Playwright, loads the store's page so the request
 * carries a genuine browser context (tonamel 403s bare server-side calls), then
 * calls their GraphQL API from inside the page. Posts each store's events to the
 * Worker in the same "title ||| url ||| date" format Distill used, so the Worker,
 * event board, filters and LINE alerts all keep working unchanged.
 *
 * Env:
 *   WEBHOOK_URL  — the Worker base URL (e.g. https://distill-alerts.mew-860.workers.dev)
 *   STORES_FILE  — optional path to the store list (default scripts/stores.json)
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const STORES_FILE = process.env.STORES_FILE || new URL("./stores.json", import.meta.url).pathname;

if (!WEBHOOK_URL) {
  console.error("WEBHOOK_URL is not set");
  process.exit(1);
}

const stores = JSON.parse(readFileSync(STORES_FILE, "utf8"));

const QUERY = `query getOrganizationGameCompetitions($organizationId: ID!, $gameId: ID!, $filter: CompetitionsFilter!) {
  organization(id: $organizationId) {
    id
    game(id: $gameId) {
      competitions(filter: $filter) {
        edges { node { id title status publicStatus
          tournaments { displayStartAt }
          entryMenus { participantChosenNum endAt countSummary { currentEntrantNum } }
        } }
      }
    }
  }
}`;

/** Unix seconds → "Sun, Aug 2 2026" in JST (the stores' local time). */
function fmtDate(unixSeconds) {
  if (!unixSeconds) return "";
  const d = new Date(Number(unixSeconds) * 1000);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d).replace(/,/g, "");
}

/**
 * Fallback: read the rendered listing straight out of the DOM. Slightly less
 * data than the API (no exact timestamps — we take the card's date text), but
 * it works whenever the page itself renders, which is what Distill relied on.
 */
async function scrapeStore(page) {
  await page.waitForSelector("li.competition-item", { timeout: 20000 });
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("li.competition-item a.nuxt-link")).map((a) => {
      const t = a.querySelector(".title");
      const title = (t ? t.textContent : a.textContent.split("\n")[0]).trim();
      let date = "";
      for (const s of a.querySelectorAll(".competition-data span")) {
        const v = s.textContent.trim();
        if (/20\d\d|\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|Mon|Tue|Wed|Thu|Fri|Sat|Sun/.test(v)) {
          date = v;
          break;
        }
      }
      return { title: title.replace(/\s*\|\|\|\s*/g, " "), url: a.href, date };
    }).filter((e) => e.title && e.url)
  );
}

/** Map the API's competition nodes to our wire format. */
function nodesToEvents(edges) {
  return edges
    .map((e) => e?.node)
    .filter((n) => n && n.id && n.publicStatus === "PUBLIC")
    .map((n) => {
      // An event can have several entry menus (pre-lottery + same-day, or one
      // per time slot). Registration is open until the LAST of them closes,
      // and capacity is their total — reading only the first gets both wrong.
      const all = n.entryMenus || [];
      const participation = all.filter((m) => m && m.forParticipation !== false);
      const menus = participation.length ? participation : all.filter(Boolean);

      const ends = menus.map((m) => Number(m.endAt)).filter((v) => Number.isFinite(v) && v > 0);
      const lastEnd = ends.length ? Math.max(...ends) : null;

      const entrants = menus.reduce((sum, m) => {
        const v = m.countSummary?.currentEntrantNum;
        return v != null ? sum + v : sum;
      }, 0);
      const capacity = menus.reduce((sum, m) => {
        const v = m.participantChosenNum;
        return v != null ? sum + v : sum;
      }, 0);
      const hasCounts = menus.some(
        (m) => m.countSummary?.currentEntrantNum != null && m.participantChosenNum != null
      );

      // Also fall back to the latest tournament start if the first is missing.
      const starts = (n.tournaments || [])
        .map((t) => Number(t?.displayStartAt))
        .filter((v) => Number.isFinite(v) && v > 0);

      return {
        title: (n.title || "").replace(/\s*\|\|\|\s*/g, " ").trim(),
        url: `https://tonamel.com/competition/${n.id}`,
        date: starts.length ? fmtDate(String(Math.min(...starts))) : "",
        deadline: lastEnd ? fmtDate(String(lastEnd)) : "",
        spots: hasCounts ? `${entrants}/${capacity}` : "",
      };
    })
    .filter((e) => e.title);
}

/**
 * Preferred path: listen for the SPA's own GraphQL response as the page loads.
 * The site's request succeeds where ours is refused, and it already asks for
 * the entry window and entrant counts.
 */
async function interceptStore(page, store) {
  const referer = `https://tonamel.com/organization/${store.org}?game=${store.game}`;
  let captured = null;

  const onResponse = async (resp) => {
    if (captured) return;
    if (!resp.url().includes("/graphql/competition_management")) return;
    if (resp.status() !== 200) return;
    try {
      const body = await resp.json();
      const edges = body?.data?.organization?.game?.competitions?.edges;
      if (Array.isArray(edges) && edges.length) captured = edges;
    } catch (e) {
      /* not the payload we want */
    }
  };

  page.on("response", onResponse);
  try {
    await page.goto(referer, { waitUntil: "domcontentloaded", timeout: 60000 });
    // Give the SPA time to issue and receive its data call.
    for (let i = 0; i < 20 && !captured; i++) await page.waitForTimeout(500);
  } finally {
    page.off("response", onResponse);
  }

  return captured ? nodesToEvents(captured) : null;
}

async function fetchStoreViaOwnRequest(page, store) {
  const referer = `https://tonamel.com/organization/${store.org}?game=${store.game}`;
  await page.goto(referer, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Let the SPA boot so the API call happens in a fully-initialised context.
  await page.waitForTimeout(3000);

  const result = await page.evaluate(
    async ({ query, org, game }) => {
      const resp = await fetch("/graphql/competition_management", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          operationName: "getOrganizationGameCompetitions",
          variables: {
            organizationId: org,
            gameId: game,
            filter: { first: 0, last: 40, before: "", after: "" },
          },
          query,
        }),
      });
      return { status: resp.status, body: await resp.text() };
    },
    { query: QUERY, org: store.org, game: store.game }
  );

  if (result.status !== 200) {
    console.log(`  API said HTTP ${result.status} — falling back to DOM scrape`);
    return scrapeStore(page);
  }

  let data;
  try {
    data = JSON.parse(result.body);
  } catch (e) {
    console.log("  API returned non-JSON — falling back to DOM scrape");
    return scrapeStore(page);
  }
  if (data.errors) {
    console.log(`  API errors (${JSON.stringify(data.errors).slice(0, 120)}) — falling back to DOM scrape`);
    return scrapeStore(page);
  }

  const edges = data?.data?.organization?.game?.competitions?.edges;
  if (!Array.isArray(edges)) {
    console.log("  unexpected API shape — falling back to DOM scrape");
    return scrapeStore(page);
  }

  console.log("  via own API request");
  return nodesToEvents(edges);
}

/** Try, in order: intercept the site's own API response → our own API request → DOM. */
async function fetchStore(page, store) {
  const intercepted = await interceptStore(page, store);
  if (intercepted && intercepted.length) {
    console.log("  via intercepted API response");
    return intercepted;
  }
  console.log("  no API response captured — trying a direct request");
  return fetchStoreViaOwnRequest(page, store);
}

async function post(store, events) {
  // Wire format: title ||| url ||| date ||| deadline ||| spots
  // (trailing fields are optional — the Worker tolerates 2- and 3-field lines)
  const text = events
    .map((e) => `${e.title} ||| ${e.url} ||| ${e.date || ""} ||| ${e.deadline || ""} ||| ${e.spots || ""}`)
    .join("\n");
  const body = new URLSearchParams({ name: store.name, uri: `https://tonamel.com/organization/${store.org}?game=${store.game}`, text });
  const resp = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const reply = (await resp.text()).trim();
  console.log(`  → worker: HTTP ${resp.status} ${reply}`);
  if (resp.status !== 200) process.exitCode = 1;
}

const browser = await chromium.launch();
const context = await browser.newContext({
  locale: "en-US",
  timezoneId: "Asia/Tokyo",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
});
const page = await context.newPage();

for (const store of stores) {
  console.log(`\n${store.name} (${store.org})`);
  try {
    const events = await fetchStore(page, store);
    console.log(
      `  captured ${events.length} events; ${events.filter((e) => e.date).length} with dates, ` +
        `${events.filter((e) => e.deadline).length} with entry deadlines`
    );
    if (events.length) await post(store, events);
    else console.log("  (nothing captured — skipping post)");
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

await browser.close();
