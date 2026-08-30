// Pulls fresh entry timestamps from the Notion BACKTESTING data source and
// rewrites the ENTRY_TIMESTAMPS_UTC snapshot embedded in index.html.
// Run by .github/workflows/sync.yml on a schedule.
const fs = require("fs");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error("Missing NOTION_TOKEN env var (set it as a repo secret).");
  process.exit(1);
}

// BACKTESTING data source (collection) ID.
const DATA_SOURCE_ID = "207f7bb7-7d6d-80d7-b4f0-000bec43a2e3";
const HTML_PATH = "index.html";

const HEADERS_BASE = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Content-Type": "application/json",
};

async function queryAllPages() {
  const attempts = [
    { url: `https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, notionVersion: "2025-09-03" },
    { url: `https://api.notion.com/v1/databases/${DATA_SOURCE_ID}/query`, notionVersion: "2022-06-28" },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const rows = await paginateQuery(attempt.url, attempt.notionVersion);
      console.log(`Fetched ${rows.length} rows via ${attempt.url}`);
      return rows;
    } catch (err) {
      console.warn(`Attempt against ${attempt.url} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw lastError || new Error("All Notion query attempts failed");
}

async function paginateQuery(url, notionVersion) {
  const headers = { ...HEADERS_BASE, "Notion-Version": notionVersion };
  let results = [];
  let cursor = undefined;

  do {
    const body = {
      page_size: 100,
      filter: { property: "Date", date: { is_not_empty: true } },
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

function extractTimestamps(pages) {
  const timestamps = [];
  for (const page of pages) {
    const dateProp = page.properties?.["Date"]?.date;
    if (!dateProp || !dateProp.start) continue;
    // Only keep entries that actually carry a time component — date-only
    // rows have no meaningful entry time for this chart.
    if (!dateProp.start.includes("T")) continue;
    timestamps.push(dateProp.start);
  }
  timestamps.sort();
  return timestamps;
}

function updateHtml(timestamps) {
  const html = fs.readFileSync(HTML_PATH, "utf8");
  const syncedAt = new Date().toISOString();

  const tsLiteral = JSON.stringify(timestamps);
  const newBlock =
`// SYNC_MARKER_START
// Auto-updated by .github/workflows/sync.yml — do not hand-edit between the markers.
const DATA_SYNCED_AT = "${syncedAt}";
const ENTRY_TIMESTAMPS_UTC = ${tsLiteral};
// SYNC_MARKER_END`;

  const re = /\/\/ SYNC_MARKER_START[\s\S]*?\/\/ SYNC_MARKER_END/;
  if (!re.test(html)) {
    throw new Error("Could not find SYNC_MARKER_START / SYNC_MARKER_END block in index.html");
  }
  const updated = html.replace(re, newBlock);
  fs.writeFileSync(HTML_PATH, updated, "utf8");
  console.log(`Wrote ${timestamps.length} entry timestamps into ${HTML_PATH} (synced at ${syncedAt}).`);
}

(async () => {
  try {
    const pages = await queryAllPages();
    const timestamps = extractTimestamps(pages);
    updateHtml(timestamps);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
})();
