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

async function fetchStore(page, store) {
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

  console.log("  via API");
  return edges
    .map((e) => e?.node)
    .filter((n) => n && n.id && n.publicStatus === "PUBLIC")
    .map((n) => {
      const start = n.tournaments?.[0]?.displayStartAt;
      return {
        title: (n.title || "").replace(/\s*\|\|\|\s*/g, " ").trim(),
        url: `https://tonamel.com/competition/${n.id}`,
        date: fmtDate(start),
      };
    })
    .filter((e) => e.title);
}

async function post(store, events) {
  const text = events.map((e) => `${e.title} ||| ${e.url} ||| ${e.date}`).join("\n");
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
    console.log(`  captured ${events.length} events; ${events.filter((e) => e.date).length} with dates`);
    if (events.length) await post(store, events);
    else console.log("  (nothing captured — skipping post)");
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

await browser.close();
