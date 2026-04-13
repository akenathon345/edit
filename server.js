require('dotenv').config({ override: true });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const https = require('https');
const http = require('http');
const { getSupabase } = require('./lib/supabase');
const { getAnthropicClient } = require('./lib/anthropic');
const { runPipeline } = require('./lib/pipeline');
const { callManagedAgent, callManagedAgentWithCallback, archiveSession } = require('./lib/managed-agent');
const { cleanupPath } = require('./lib/cleanup');

// ── Concurrency queue (max concurrent pipelines) ─────────────────────────
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_PIPELINES || '5', 10);
let _pLimit;
async function getPLimit() {
  if (!_pLimit) {
    const mod = await import('p-limit');
    _pLimit = mod.default(MAX_CONCURRENT);
  }
  return _pLimit;
}

// ── Auth middleware ───────────────────────────────────────────────────────
const API_KEY = process.env.VE_EDIT_API_KEY || '';
function authMiddleware(req, res, next) {
  // Skip auth if no key configured (backward compat)
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (provided !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized — x-api-key header requis' });
  }
  next();
}

// Download a video from URL to a local temp file (with redirect depth limit)
function downloadVideo(url, destPath, _depth = 0) {
  const MAX_REDIRECTS = 5;
  if (_depth > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects (${MAX_REDIRECTS})`));
  }
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, { headers: { 'User-Agent': 've-edit-api/1.0' } }, (res) => {
      // Follow redirects (with depth limit)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return resolve(downloadVideo(res.headers.location, destPath, _depth + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    }).on('error', (err) => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
  });
}

const app = express();
const PORT = process.env.PORT || 3002;
const BUNDLE_TMP_DIR = process.env.BUNDLE_TMP_DIR || '/tmp/ve-edit-bundles';

// Ensure tmp dir exists
fs.mkdirSync(BUNDLE_TMP_DIR, { recursive: true });

app.use((req, res, next) => {
  express.json({ limit: '50mb' })(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: 'JSON invalide dans le body' });
    next();
  });
});

// Multer for video upload
const upload = multer({ dest: path.join(BUNDLE_TMP_DIR, 'uploads') });

// In-memory store for run results — TTL-based eviction (1h)
const runResults = new Map();
const RUN_RESULTS_TTL_MS = 60 * 60 * 1000; // 1 hour
function setRunResult(runId, data) {
  runResults.set(runId, { ...data, _ts: Date.now() });
  // Evict old entries
  if (runResults.size > 200) {
    const now = Date.now();
    for (const [key, val] of runResults) {
      if (now - val._ts > RUN_RESULTS_TTL_MS) runResults.delete(key);
    }
  }
}
function getRunResult(runId) {
  const entry = runResults.get(runId);
  if (!entry) return null;
  if (Date.now() - entry._ts > RUN_RESULTS_TTL_MS) { runResults.delete(runId); return null; }
  const { _ts, ...data } = entry;
  return data;
}

// Safe Supabase helper — never throws, but logs warnings
async function sbSafe(fn) {
  try { await fn(); } catch (err) { console.warn('[sbSafe] Supabase error:', err?.message || err); }
}

// ── POST /ve-edit ──────────────────────────────────────────────────────────
app.post('/ve-edit', authMiddleware, upload.single('video'), async (req, res) => {
  const supabase = getSupabase();
  const anthropic = getAnthropicClient();

  if (!anthropic) {
    return res.status(500).json({ success: false, error: 'ANTHROPIC_API_KEY manquante' });
  }

  // Parse input
  let videoPath = req.file ? req.file.path : req.body.video_path;
  const videoUrl = req.body.video_url;
  const clientSlug = req.body.client_slug;
  const version = req.body.version || 'V1';
  const take = req.body.take || 'T1';
  const callbackUrl = req.body.callback_url;
  const verbose = req.body.verbose === true || req.body.verbose === 'true';

  // Pass-through fields — renvoyés tels quels dans le callback
  // Accepte les deux formats : notion_content_id (snake_case) et notion-content-id (kebab-case, format CUT)
  const passThrough = {};
  const notionId = req.body['notion-content-id'] || req.body.notion_content_id;
  if (notionId) passThrough['notion-content-id'] = notionId;
  if (req.body.title) passThrough.title = req.body.title;
  if (req.body.pass_through) Object.assign(passThrough, req.body.pass_through);

  // Download video from URL if provided
  if (!videoPath && videoUrl) {
    try {
      const ext = path.extname(new URL(videoUrl).pathname) || '.mp4';
      const destFile = path.join(BUNDLE_TMP_DIR, 'uploads', `dl_${Date.now()}${ext}`);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      console.log(`[server] Downloading video from URL: ${videoUrl.substring(0, 80)}...`);
      videoPath = await downloadVideo(videoUrl, destFile);
      console.log(`[server] Download complete: ${destFile}`);
    } catch (err) {
      return res.status(400).json({ success: false, error: `Échec du téléchargement vidéo: ${err.message}` });
    }
  }

  if (!videoPath) {
    return res.status(400).json({ success: false, error: 'video_path, video_url ou fichier video requis' });
  }
  // Validate path exists (for non-upload mode)
  if (!req.file && !videoUrl && !fs.existsSync(videoPath)) {
    return res.status(400).json({ success: false, error: `video_path introuvable: ${videoPath}` });
  }

  const runId = uuidv4();
  const videoName = path.basename(videoPath, path.extname(videoPath));

  // Log run start
  await sbSafe(() => supabase?.from('ve_edit_runs').insert({
    id: runId, client_slug: clientSlug, video_name: videoName,
    version, take, status: 'running',
  }));

  // Async mode (callback_url provided)
  if (callbackUrl) {
    res.status(202).json({ run_id: runId, status: 'processing', ...passThrough });
    const limit = await getPLimit();
    limit(() => runPipelineAndCallback(anthropic, supabase, {
      runId, videoPath, clientSlug, version, take, videoName, verbose, callbackUrl, passThrough,
    }));
    return;
  }

  // Sync mode — wait for result (also queued)
  try {
    const limit = await getPLimit();
    const result = await limit(() => runPipeline(anthropic, supabase, {
      runId, videoPath, clientSlug, version, take, videoName, verbose,
    }));

    setRunResult(runId, { status: 'completed', result });

    await sbSafe(() => supabase?.from('ve_edit_runs').update({
      status: 'completed', score: result.score,
      directives_count: result.directives.length,
      tokens_total: result.metadata.tokens_total,
      cost_estimate: result.metadata.cost_estimate,
      duration_ms: result.metadata.duration_ms,
      markdown_output: result.markdown,
    }).eq('id', runId));

    res.json({ success: true, run_id: runId, ...passThrough, ...result });
  } catch (err) {
    console.error(`[run:${runId}] Pipeline error:`, err.message);

    await sbSafe(() => supabase?.from('ve_edit_runs').update({
      status: 'failed', error: err.message,
    }).eq('id', runId));

    setRunResult(runId, { status: 'failed', error: err.message });
    res.status(500).json({ success: false, run_id: runId, ...passThrough, error: err.message });
  } finally {
    // Cleanup uploaded/downloaded video
    if (videoPath) cleanupPath(videoPath);
  }
});

// ── GET /ve-edit/:run_id ──────────────────────────────────────────────────
app.get('/ve-edit/:runId', async (req, res) => {
  const { runId } = req.params;

  const cached = getRunResult(runId);
  if (cached) {
    return res.json({ run_id: runId, ...cached });
  }

  try {
    const supabase = getSupabase();
    if (supabase) {
      const { data } = await supabase.from('ve_edit_runs')
        .select('*').eq('id', runId).maybeSingle();
      if (data) {
        return res.json({
          run_id: runId,
          status: data.status,
          result: data.status === 'completed' ? {
            score: data.score,
            directives_count: data.directives_count,
            markdown: data.markdown_output,
          } : undefined,
          error: data.error,
        });
      }
    }
  } catch {}

  res.status(404).json({ error: 'Run not found' });
});

// ── Background pipeline + callback ────────────────────────────────────────
async function runPipelineAndCallback(anthropic, supabase, opts) {
  const { runId, videoPath, callbackUrl, passThrough, ...pipelineOpts } = opts;

  let payload;
  try {
    const result = await runPipeline(anthropic, supabase, { runId, videoPath, ...pipelineOpts });
    payload = { success: true, run_id: runId, ...passThrough, ...result };
    setRunResult(runId, { status: 'completed', result });

    await sbSafe(() => supabase?.from('ve_edit_runs').update({
      status: 'completed', score: result.score,
      directives_count: result.directives.length,
      tokens_total: result.metadata.tokens_total,
      cost_estimate: result.metadata.cost_estimate,
      duration_ms: result.metadata.duration_ms,
      markdown_output: result.markdown,
    }).eq('id', runId));
  } catch (err) {
    console.error(`[run:${runId}] Pipeline error:`, err.message);
    payload = { success: false, run_id: runId, ...passThrough, error: err.message };
    setRunResult(runId, { status: 'failed', error: err.message });

    await sbSafe(() => supabase?.from('ve_edit_runs').update({
      status: 'failed', error: err.message,
    }).eq('id', runId));
  } finally {
    // Cleanup uploaded/downloaded video
    if (videoPath) cleanupPath(videoPath);
  }

  // Callback with retry (up to 3 attempts)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        console.log(`[run:${runId}] Callback sent to ${callbackUrl}`);
        return;
      }
      console.warn(`[run:${runId}] Callback HTTP ${resp.status}, attempt ${attempt + 1}/3`);
    } catch (err) {
      console.warn(`[run:${runId}] Callback failed (attempt ${attempt + 1}/3):`, err.message);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
  }
  console.error(`[run:${runId}] Callback failed after 3 attempts to ${callbackUrl}`);
}

// ── POST /managed-agent ──────────────────────────────────────────────────
// Appelle le managed agent Anthropic (Sessions API beta)
// Body: { input: string, callback_url?: string, metadata?: object }
app.post('/managed-agent', authMiddleware, async (req, res) => {
  const { input, callback_url, metadata } = req.body;

  if (!input) {
    return res.status(400).json({ success: false, error: 'input requis' });
  }

  // Mode async avec callback
  if (callback_url) {
    res.status(202).json({ status: 'processing', message: 'Agent lancé, résultat envoyé au callback_url' });
    callManagedAgentWithCallback(input, callback_url, { metadata }).then(result => {
      if (result.sessionId) {
        archiveSession(result.sessionId).catch(() => {});
      }
    });
    return;
  }

  // Mode sync — attend la réponse complète
  try {
    const result = await callManagedAgent(input);

    // Archiver la session après usage
    if (result.sessionId) {
      archiveSession(result.sessionId).catch(() => {});
    }

    if (result.error) {
      return res.status(502).json({
        success: false,
        session_id: result.sessionId,
        partial_text: result.text,
        error: result.error,
      });
    }

    res.json({
      success: true,
      session_id: result.sessionId,
      analysis: result.text,
    });
  } catch (err) {
    console.error('[managed-agent] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 've-edit-api',
    queue: {
      max_concurrent: MAX_CONCURRENT,
      active: _pLimit ? _pLimit.activeCount : 0,
      pending: _pLimit ? _pLimit.pendingCount : 0,
    },
    cached_results: runResults.size,
    uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

// Python/cv2 diagnostic
app.get('/health/python', async (req, res) => {
  const { spawn } = require('child_process');
  const proc = spawn('python3', ['-c', 'import cv2; print("cv2 OK:", cv2.__version__); import sys; print("python:", sys.executable)']);
  let out = '', err = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    res.json({ code, stdout: out.trim(), stderr: err.trim() });
  });
});

// Global error handler — never crash
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err.message);
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: `Erreur interne: ${err.message}` });
  }
});

// Catch uncaught errors — keep process alive
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] Unhandled rejection:', err?.message || err);
});

app.listen(PORT, () => {
  console.log(`VE Edit API running on port ${PORT} (max ${MAX_CONCURRENT} concurrent pipelines)`);

  // Periodic /tmp cleanup every 30 minutes
  const { cleanupOldFiles } = require('./lib/cleanup');
  setInterval(() => {
    cleanupOldFiles(BUNDLE_TMP_DIR, 2 * 60 * 60 * 1000); // 2h max age
  }, 30 * 60 * 1000);
});
