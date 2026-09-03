// Pulls fresh entry timestamps from two Notion data sources and rewrites the
// snapshots embedded in index.html:
//   - BACKTESTING       -> ENTRY_TIMESTAMPS_UTC       (real UTC, converted to ET client-side)
//   - PHASE 1 JOURNAL   -> PHASE1_ENTRY_TIMESTAMPS    (floating datetime, already NY wall-clock)
// Run by .github/workflows/sync.yml on a schedule.
const fs = require("fs");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN env var (set it as a repo secret).");
  process.exit(1);
}

const BACKTESTING_DATA_SOURCE_ID = "207f7bb7-7d6d-80d7-b4f0-000bec43a2e3";
const PHASE1_DATA_SOURCE_ID = "2c1f7bb7-7d6d-812c-b034-000bef8295e6";
const HTML_PATH = "index.html";

const HEADERS_BASE = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Content-Type": "application/json",
};

const DEBUG_LOG = {
  tokenPresent: !!NOTION_TOKEN,
  tokenLength: NOTION_TOKEN ? NOTION_TOKEN.length : 0,
  backtesting: { attempts: [] },
  phase1: { attempts: [] },
};

function writeDebugLog() {
  try {
    fs.writeFileSync(".sync-debug.json", JSON.stringify(DEBUG_LOG, null, 2), "utf8");
  } catch (e) { /* best effort */ }
}

async function queryAllPages(dataSourceId, dateProperty, debugBucket) {
  const attempts = [
    { url: `https://api.notion.com/v1/data_sources/${dataSourceId}/query`, notionVersion: "2025-09-03" },
    { url: `https://api.notion.com/v1/databases/${dataSourceId}/query`, notionVersion: "2022-06-28" },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const rows = await paginateQuery(attempt.url, attempt.notionVersion, dateProperty);
      console.log(`Fetched ${rows.length} rows via ${attempt.url}`);
      debugBucket.attempts.push({ url: attempt.url, ok: true, rows: rows.length });
      return rows;
    } catch (err) {
      console.warn(`Attempt against ${attempt.url} failed: ${err.message}`);
      debugBucket.attempts.push({ url: attempt.url, ok: false, error: err.message });
      lastError = err;
    }
  }
  throw lastError || new Error("All Notion query attempts failed");
}

async function paginateQuery(url, notionVersion, dateProperty) {
  const headers = { ...HEADERS_BASE, "Notion-Version": notionVersion };
  let results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: { property: dateProperty, date: { is_not_empty: true } },
    };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return results;
}

function extractTimestamps(pages, dateProperty) {
  const timestamps = [];
  for (const page of pages) {
    const dateProp = page.properties?.[dateProperty]?.date;
    if (!dateProp || !dateProp.start) continue;
    // Only keep entries that actually carry a time component — date-only
    // rows have no meaningful entry time for this chart.
    if (!dateProp.start.includes("T")) continue;
    timestamps.push(dateProp.start);
  }
  timestamps.sort();
  return timestamps;
}

// Same as extractTimestamps, but also pulls a select property (e.g. Outcome)
// and keeps it paired with its timestamp through the sort, so the two
// parallel arrays written to index.html stay aligned by index.
function extractTimestampsWithOutcome(pages, dateProperty, outcomeProperty) {
  const rows = [];
  for (const page of pages) {
    const dateProp = page.properties?.[dateProperty]?.date;
    if (!dateProp || !dateProp.start) continue;
    if (!dateProp.start.includes("T")) continue;
    const outcome = page.properties?.[outcomeProperty]?.select?.name || null;
    rows.push({ ts: dateProp.start, outcome });
  }
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { timestamps: rows.map(r => r.ts), outcomes: rows.map(r => r.outcome) };
}

function updateHtml(backtestingTimestamps, phase1Timestamps, phase1Outcomes) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const syncedAt = new Date().toISOString();

  const btLiteral = JSON.stringify(backtestingTimestamps);
  const p1Literal = JSON.stringify(phase1Timestamps);
  const p1OutcomeLiteral = JSON.stringify(phase1Outcomes);
  const newBlock =
`// SYNC_MARKER_START
// Auto-updated by .github/workflows/sync.yml — do not hand-edit between the markers.
const DATA_SYNCED_AT = "${syncedAt}";
const ENTRY_TIMESTAMPS_UTC = ${btLiteral};
const PHASE1_ENTRY_TIMESTAMPS = ${p1Literal};
const PHASE1_ENTRY_OUTCOMES = ${p1OutcomeLiteral};
// SYNC_MARKER_END`;

  const re = /\/\/ SYNC_MARKER_START[\s\S]*?\/\/ SYNC_MARKER_END/;
  if (!re.test(html)) {
    throw new Error("Could not find SYNC_MARKER_START / SYNC_MARKER_END block in index.html");
  }
  const updated = html.replace(re, newBlock);
  fs.writeFileSync(HTML_PATH, updated, "utf8");
  console.log(`Wrote ${backtestingTimestamps.length} Backtesting + ${phase1Timestamps.length} Phase 1 Journal timestamps into ${HTML_PATH} (synced at ${syncedAt}).`);
}

(async () => {
  let backtestingTimestamps = [];
  let phase1Timestamps = [];
  let phase1Outcomes = [];
  let hadError = false;

  try {
    const pages = await queryAllPages(BACKTESTING_DATA_SOURCE_ID, "Date", DEBUG_LOG.backtesting);
    backtestingTimestamps = extractTimestamps(pages, "Date");
  } catch (err) {
    console.error("Backtesting sync failed:", err);
    DEBUG_LOG.backtesting.error = err.message;
    hadError = true;
  }

  try {
    const pages = await queryAllPages(PHASE1_DATA_SOURCE_ID, "ENTRY TIME ", DEBUG_LOG.phase1);
    const extracted = extractTimestampsWithOutcome(pages, "ENTRY TIME ", "Outcome");
    phase1Timestamps = extracted.timestamps;
    phase1Outcomes = extracted.outcomes;
  } catch (err) {
    console.error("Phase 1 Journal sync failed:", err);
    DEBUG_LOG.phase1.error = err.message;
    hadError = true;
  }

  try {
    updateHtml(backtestingTimestamps, phase1Timestamps, phase1Outcomes);
  } catch (err) {
    console.error("Failed to write index.html:", err);
    hadError = true;
  }

  writeDebugLog();
  if (hadError) process.exit(1);
})();
