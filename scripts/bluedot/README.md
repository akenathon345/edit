# BlueDot Collection Scraper

Downloads every PPM (meeting) of a BlueDot collection — title, metadata, AI summary, full transcript reconstructed from word-level segments — into one Markdown file per meeting.

BlueDot has no documented public REST API for pulling meetings, but the internal endpoints used by the BlueDot SPA are reachable **without authentication for any collection that has been published with a share link** (`isPublished: true`). This script uses those endpoints directly — no cookie or token needed.

## Endpoints reverse-engineered

| Purpose | Endpoint |
|---|---|
| List meetings in a collection | `GET /api/v1/workspaces/{workspaceId}/videos?pageNumber=&pageSize=16&tenancy=workspace&collectionId=&sortBy=uploadedAt&order=desc` |
| Per-meeting detail (incl. transcript + summary) | `GET /_next/data/{buildId}/preview/{videoId}.json` |

The transcript lives at `pageProps.video.videoTranscription.transcription`, an array of word-level segments `{start, end, text, speakerTag, paragraph, silence}`. The script regroups them into speaker turns.

The AI summary lives at `pageProps.video.summary.summary.entries[]`.

## Authentication

**None required** for published collections. The script still expects a `cookies.txt` file (kept for forward compatibility with private collections) — just put any non-empty placeholder string in it.

```bash
echo "_dummy=anon" > cookies.txt
```

If you ever scrape a private (non-published) collection, paste a real Cookie header from Chrome DevTools → Network → any `/api/v1/*` request → Request Headers → `Cookie:`.

## Usage

```bash
cd ve-edit-api/scripts/bluedot

# Smoke test: 2 meetings
node scrape-collection.js \
  --collection 6673c1a5ff7b5da37b4b6e23 \
  --workspace 65f3d48ef804d28b23649a0f \
  --cookies ./cookies.txt \
  --out ./out \
  --limit 2

# Full pull, parallel by 6
node scrape-collection.js \
  --collection 6673c1a5ff7b5da37b4b6e23 \
  --workspace 65f3d48ef804d28b23649a0f \
  --cookies ./cookies.txt \
  --out ./out \
  --concurrency 6
```

Reference: 32 PPMs scraped in ≈7s with concurrency 6.

## Output

```
out/
├── index.json                 # summary of run
├── 001_chirurgie-refractive.md
├── 002_rdv-editorial-prsnl-shiva-shaffii.md
├── ...
```

Each `.md` file contains:
- meeting metadata (id, createdAt, duration, language)
- AI-generated summary (sections + bullet points)
- Full transcript reconstructed as `Speaker: A: ...` paragraphs

## Where the IDs come from

- `--collection` = the path segment of your share link, e.g. `https://app.bluedothq.com/collection/6673c1a5ff7b5da37b4b6e23`
- `--workspace` = your BlueDot workspace ID. Find it via DevTools → any `/api/v1/workspaces/{ID}/...` request — the `{ID}` is your workspace ID.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` errors | Cookie expired — re-extract |
| `400 Too big: expected number to be <=16` | pageSize hardcoded to 16, don't change it |
| Empty transcript | Meeting transcription not yet finished on BlueDot side. Re-run later. |
| Rate limit (429) | Lower `--concurrency` (try 2). |
