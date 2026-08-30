# MMTrades — Entry Time Distribution

Shows when trades from the Notion **BACKTESTING** database actually get entered during the trading day:

- **Line chart** — trade count across the full 9:30 AM–4:00 PM ET session, in 5-minute buckets.
- **Heatmap** — the same buckets as a colored strip (darker = more entries), with the 12:00–1:30 PM lunch dead zone trimmed out for visibility.

Entry times are stored in Notion as UTC and converted to `America/New_York` (DST-aware) at render time.

## Setup

1. **Add the `NOTION_TOKEN` secret** to this repo: Settings → Secrets and variables → Actions → New repository secret. Use the same integration token already used on the other `mmtrades-*` repos (it needs read access to the `BACKTESTING` database).
2. **Enable GitHub Pages**: Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)`.
3. **Run the sync once manually**: Actions tab → "Sync Notion entry times" → Run workflow. After that it runs automatically every 5 minutes.

Your page will be live at `https://<your-username>.github.io/<this-repo-name>/`.

## Files

- `index.html` — the page itself (line chart + heatmap, dark/light theme, self-contained).
- `sync.js` — pulls the `Date` property (datetime rows only) from the BACKTESTING data source and rewrites the `ENTRY_TIMESTAMPS_UTC` array between the `SYNC_MARKER_START` / `SYNC_MARKER_END` comments in `index.html`.
- `.github/workflows/sync.yml` — runs `sync.js` on a schedule and commits the result.
