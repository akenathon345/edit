#!/usr/bin/env node
/**
 * BlueDot collection scraper
 *
 * Downloads every PPM (meeting) of a BlueDot collection: title, metadata,
 * AI summary, and full transcript reconstructed from word-level segments.
 *
 * Usage:
 *   node scrape-collection.js \
 *     --collection 6673c1a5ff7b5da37b4b6e23 \
 *     --workspace 65f3d48ef804d28b23649a0f \
 *     --cookies ./cookies.txt \
 *     --out ./out \
 *     [--concurrency 4] [--limit 5]
 *
 * Cookies file: a single line containing the value of the Cookie header
 * copied from a real /api/v1/* request in Chrome DevTools Network tab.
 * See README.md for the 30-second extraction procedure.
 */

const fs = require('fs');
const path = require('path');

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const COLLECTION_ID = args.collection;
const WORKSPACE_ID = args.workspace;
const COOKIES_FILE = args.cookies || './cookies.txt';
const OUT_DIR = args.out || './out';
const CONCURRENCY = parseInt(args.concurrency || '4', 10);
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;

if (!COLLECTION_ID || !WORKSPACE_ID) {
  console.error('Usage: node scrape-collection.js --collection <id> --workspace <id> --cookies <file> --out <dir>');
  process.exit(1);
}

const HOST = 'https://app.bluedothq.com';
const cookie = fs.readFileSync(COOKIES_FILE, 'utf8').trim();

if (!cookie) {
  console.error('Cookies file is empty');
  process.exit(1);
}

const baseHeaders = {
  cookie,
  accept: 'application/json',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
};

// ---------- helpers ----------
async function api(pathWithQuery) {
  const res = await fetch(HOST + pathWithQuery, { headers: baseHeaders });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${pathWithQuery}`);
  return res.json();
}

async function listVideos() {
  // BlueDot returns `pagination.total` = total page count (not item count).
  // Safest approach: paginate until an empty page comes back.
  const all = [];
  let page = 1;
  while (true) {
    const url = `/api/v1/workspaces/${WORKSPACE_ID}/videos?pageNumber=${page}&pageSize=16&tenancy=workspace&collectionId=${COLLECTION_ID}&sortBy=uploadedAt&order=desc`;
    const data = await api(url);
    const items = data.items || [];
    if (items.length === 0) break;
    all.push(...items);
    console.log(`  page ${page}: +${items.length} videos (running total: ${all.length})`);
    page += 1;
  }
  // Dedupe by id (pagination overlap can occur)
  const byId = new Map();
  for (const v of all) byId.set(v.id, v);
  return [...byId.values()];
}

// Extract a stable "client key" from the meeting title.
// Examples:
//   "RDV Éditorial PRSNL - Florence Moine"            → "florence-moine"
//   "RDV Éditorial - Lola Janiaud x Agence Personnelle" → "lola-janiaud"
//   "PPM Elise"                                       → "ppm-elise"
//   "Chirurgie réfractive"                            → "chirurgie-refractive"
function clientKeyFromTitle(title) {
  if (!title) return 'untitled';
  let t = title.trim();
  // Strip common prefixes (case-insensitive)
  t = t.replace(/^RDV\s+Éditorial\s+(PRSNL\s+)?-\s*/i, '');
  t = t.replace(/^RDV\s+/i, '');
  // Strip the trailing "x Agence Personnelle" suffix
  t = t.replace(/\s*x\s*agence\s*personnelle\s*$/i, '');
  return slugify(t);
}

// Keep only the most recent video per client key.
function dedupeLatestPerClient(videos) {
  const latest = new Map();
  for (const v of videos) {
    const key = clientKeyFromTitle(v.title);
    const existing = latest.get(key);
    if (!existing || new Date(v.createdAt) > new Date(existing.createdAt)) {
      latest.set(key, v);
    }
  }
  return [...latest.values()].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

async function getBuildId() {
  // Fetch the homepage HTML to extract __NEXT_DATA__ buildId
  const res = await fetch(HOST + '/home', { headers: baseHeaders });
  const html = await res.text();
  const m = html.match(/"buildId":"([^"]+)"/);
  if (!m) throw new Error('Could not extract Next.js buildId from /home HTML');
  return m[1];
}

async function fetchVideoDetail(buildId, videoId) {
  return api(`/_next/data/${buildId}/preview/${videoId}.json`);
}

function reconstructTranscript(segments) {
  if (!Array.isArray(segments)) return '';
  const turns = [];
  let curSpeaker = null;
  let curPara = null;
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join(' ').replace(/\s+([,.!?])/g, '$1');
    turns.push(`${curSpeaker || '?'}: ${text}`);
    buf = [];
  };
  for (const s of segments) {
    if (s.silence) continue;
    if (s.speakerTag !== curSpeaker || s.paragraph !== curPara) {
      flush();
      curSpeaker = s.speakerTag;
      curPara = s.paragraph;
    }
    if (s.text) buf.push(s.text);
  }
  flush();
  return turns.join('\n\n');
}

function flattenSummary(summaryObj) {
  // summary.summary = { entries: [{ name, blocks: [{type, value}] }] }
  if (!summaryObj || !Array.isArray(summaryObj.entries)) return '';
  const sections = [];
  for (const entry of summaryObj.entries) {
    sections.push(`## ${entry.name || 'Section'}`);
    for (const block of entry.blocks || []) {
      if (typeof block.value === 'string') {
        sections.push(block.value);
      } else if (Array.isArray(block.value)) {
        for (const item of block.value) {
          if (typeof item === 'string') sections.push(`- ${item}`);
        }
      }
    }
    sections.push('');
  }
  return sections.join('\n');
}

function slugify(s) {
  return (s || 'untitled')
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
}

function buildMarkdown(video, summaryText, transcriptText) {
  const lines = [
    `# ${video.title || '(no title)'}`,
    '',
    `- **id**: ${video.id}`,
    `- **createdAt**: ${video.createdAt}`,
    `- **duration**: ${video.duration}s`,
    `- **language**: ${video.videoTranscription?.languageCode || 'unknown'}`,
    `- **collectionId**: ${video.collectionId}`,
    '',
    '---',
    '',
    '# Summary (AI generated by BlueDot)',
    '',
    summaryText || '_(no summary available)_',
    '',
    '---',
    '',
    '# Transcript',
    '',
    transcriptText || '_(no transcript available)_',
    '',
  ];
  return lines.join('\n');
}

// ---------- concurrent map ----------
async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err.message };
      }
    }
  }
  const workers = Array.from({ length: limit }, worker);
  await Promise.all(workers);
  return results;
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[1/4] Resolving Next.js buildId...`);
  const buildId = await getBuildId();
  console.log(`  buildId = ${buildId}`);

  console.log(`[2/4] Listing videos in collection ${COLLECTION_ID}...`);
  const videos = await listVideos();
  console.log(`  → ${videos.length} unique videos found`);

  const deduped = dedupeLatestPerClient(videos);
  console.log(`  → ${deduped.length} unique clients after dedupe (latest PPM kept per client)`);

  const targets = deduped.slice(0, LIMIT);
  console.log(`[3/4] Downloading ${targets.length} transcripts (concurrency=${CONCURRENCY})...`);

  let done = 0;
  const results = await pMapLimit(targets, CONCURRENCY, async (vid, i) => {
    const detail = await fetchVideoDetail(buildId, vid.id);
    const v = detail?.pageProps?.video || {};
    const segments = v.videoTranscription?.transcription || [];
    const summary = v.summary?.summary || null;
    const transcript = reconstructTranscript(segments);
    const summaryText = flattenSummary(summary);
    const md = buildMarkdown(v, summaryText, transcript);
    const clientKey = clientKeyFromTitle(v.title);
    const filename = `${clientKey}.md`;
    const filepath = path.join(OUT_DIR, filename);
    fs.writeFileSync(filepath, md, 'utf8');
    done += 1;
    process.stdout.write(`  [${done}/${targets.length}] ${filename} (${transcript.length} chars transcript)\n`);
    return { id: v.id, title: v.title, clientKey, file: filename, transcriptChars: transcript.length, summaryChars: summaryText.length, createdAt: v.createdAt };
  });

  console.log(`[4/4] Writing index.json...`);
  const okResults = results.filter((r) => r && !r.error);
  const failed = results.filter((r) => r && r.error);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({ collectionId: COLLECTION_ID, total: results.length, ok: okResults, failed }, null, 2));

  console.log(`\nDone. ${okResults.length} ok, ${failed.length} failed. Output: ${OUT_DIR}`);
  if (failed.length) console.log('Failures:', failed);
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
