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

// Download a video from URL to a local temp file
function downloadVideo(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, { headers: { 'User-Agent': 've-edit-api/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return resolve(downloadVideo(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
    }).on('error', (err) => { fs.unlinkSync(destPath); reject(err); });
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

// In-memory store for run results (backed by Supabase)
const runResults = new Map();

// Safe Supabase helper — never throws
async function sbSafe(fn) {
  try { await fn(); } catch {}
}

// ── POST /ve-edit ──────────────────────────────────────────────────────────
app.post('/ve-edit', upload.single('video'), async (req, res) => {
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
    runPipelineAndCallback(anthropic, supabase, {
      runId, videoPath, clientSlug, version, take, videoName, verbose, callbackUrl, passThrough,
    });
    return;
  }

  // Sync mode — wait for result
  try {
    const result = await runPipeline(anthropic, supabase, {
      runId, videoPath, clientSlug, version, take, videoName, verbose,
    });

    runResults.set(runId, { status: 'completed', result });

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

    runResults.set(runId, { status: 'failed', error: err.message });
    res.status(500).json({ success: false, run_id: runId, ...passThrough, error: err.message });
  }
});

// ── GET /ve-edit/:run_id ──────────────────────────────────────────────────
app.get('/ve-edit/:runId', async (req, res) => {
  const { runId } = req.params;

  const cached = runResults.get(runId);
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
  const { runId, callbackUrl, passThrough, ...pipelineOpts } = opts;

  let payload;
  try {
    const result = await runPipeline(anthropic, supabase, { runId, ...pipelineOpts });
    payload = { success: true, run_id: runId, ...passThrough, ...result };
    runResults.set(runId, { status: 'completed', result });

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
    runResults.set(runId, { status: 'failed', error: err.message });

    await sbSafe(() => supabase?.from('ve_edit_runs').update({
      status: 'failed', error: err.message,
    }).eq('id', runId));
  }

  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    console.log(`[run:${runId}] Callback sent to ${callbackUrl}`);
  } catch (err) {
    console.error(`[run:${runId}] Callback failed:`, err.message);
  }
}

// ── POST /managed-agent ──────────────────────────────────────────────────
// Appelle le managed agent Anthropic (Sessions API beta)
// Body: { input: string, callback_url?: string, metadata?: object }
app.post('/managed-agent', async (req, res) => {
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
  res.json({ status: 'ok', service: 've-edit-api' });
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
  console.log(`VE Edit API running on port ${PORT}`);
});
