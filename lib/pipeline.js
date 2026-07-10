const { extractBundle, loadBundle, isBundle } = require('./extract');
const { getSectionsForAgents } = require('./skill-sections');
const { loadClientGuidelines } = require('./guidelines');
const { a1FrameDescriber, a2Cartographer, a3HookAuditor, a35HookVisionPass, a4BrollAuditor, a45SubtitleQC, a5QC, a6Formatter } = require('./agents');
const { cleanupPath } = require('./cleanup');

/**
 * Run the full VE Edit pipeline.
 *
 * Flow:
 *   extract.py → A1 (frames→text) → A2 (cartography) → A3+A4 (parallel auditors) → A5 (QC) → A6 (formatter)
 *
 * @returns {{ score, directives, markdown, metadata }}
 */
async function runPipeline(anthropic, supabase, { runId, videoPath, clientSlug, version, take, videoName, verbose }) {
  const t0 = Date.now();
  const metrics = { agents: {} };
  let bundlePath = null; // Track for cleanup

  try {
  // ── Load skill sections + guidelines ────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  VE Edit Pipeline — ${videoName}`);
  console.log(`  Client: ${clientSlug} | Version: ${version} | Take: ${take}`);
  console.log(`${'═'.repeat(60)}\n`);

  const sections = getSectionsForAgents();
  const { icp, guidelines, clientName } = clientSlug
    ? await loadClientGuidelines(supabase, clientSlug)
    : { icp: '', guidelines: '', clientName: 'unknown' };

  // ── Step 0: Extract bundle (if not already a bundle) ────────────────────
  if (isBundle(videoPath)) {
    console.log('[pipeline] Input is already a bundle, skipping extraction');
    bundlePath = videoPath;
  } else {
    console.log('[pipeline] Extracting video bundle...');
    bundlePath = await extractBundle(videoPath);
  }

  const { index, frames } = loadBundle(bundlePath);
  const transcript = index.transcript || index.transcription || '';
  console.log(`[pipeline] Bundle loaded: ${frames.length} frames, transcript: ${transcript.length} chars`);

  if (frames.length === 0) {
    throw new Error('Bundle invalide: 0 frames extraites. Vérifier la vidéo source.');
  }
  if (!transcript) {
    console.warn('[pipeline] ⚠ Pas de transcription — les résultats seront moins précis');
  }

  // ── A1: Frame Describer (parallel batches) ──────────────────────────────
  console.log('\n── A1: Frame Describer ──────────────────────────');
  const a1Result = await a1FrameDescriber(anthropic, supabase, runId, frames);
  const frameDescriptions = a1Result.frameDescriptions;
  metrics.agents.a1_frame_describer = { tokensIn: a1Result.tokensIn, tokensOut: a1Result.tokensOut, duration_ms: a1Result.elapsed };
  console.log(`[A1] ${frameDescriptions.length} frame descriptions produced`);

  if (verbose) {
    console.log('[A1 verbose]', JSON.stringify(frameDescriptions.slice(0, 3), null, 2), '...');
  }

  // ── A2: Cartographer ────────────────────────────────────────────────────
  console.log('\n── A2: Cartographer ─────────────────────────────');
  const a2Result = await a2Cartographer(anthropic, supabase, runId, {
    frameDescriptions,
    transcript,
    icpHint: icp || `Client: ${clientName}`,
    skillSection: sections.cartographer,
  });
  const videoMap = a2Result.parsed || {};
  // Guard: ensure required fields exist
  videoMap.multi_hooks = videoMap.multi_hooks || [];
  videoMap.broll_plans = videoMap.broll_plans || [];
  videoMap.phases = videoMap.phases || [];
  videoMap.icp = videoMap.icp || icp || `Client: ${clientName}`;
  videoMap.duration_s = videoMap.duration_s || frames.length * 0.5;
  metrics.agents.a2_cartographer = { tokensIn: a2Result.tokensIn, tokensOut: a2Result.tokensOut, duration_ms: a2Result.elapsed };
  console.log(`[A2] Video map: ${videoMap.broll_plans.length} B-roll plans, ${videoMap.multi_hooks.length} hooks`);

  if (verbose) {
    console.log('[A2 verbose]', JSON.stringify(videoMap, null, 2));
  }

  // ── A3 + A3.5 + A4 + A4.5: Auditors (PARALLEL — resilient) ──────────────
  console.log('\n── A3+A3.5+A4+A4.5: Auditors (parallel) ─────────');

  // A3.5 : frames BRUTES de la zone hook (le seul auditeur qui voit les pixels)
  const a35Enabled = process.env.A35_ENABLED !== 'false';
  const a45Enabled = process.env.A45_ENABLED !== 'false';
  const hookEndS = (videoMap.hook_to_body_transition_s || 10) + 2;
  const hookFramesRaw = frames.filter(f => (f.timecode_s ?? f.index * 0.5) <= hookEndS);

  const [a3Settled, a4Settled, a35Settled, a45Settled] = await Promise.allSettled([
    a3HookAuditor(anthropic, supabase, runId, {
      videoMap,
      frameDescriptions,
      guidelines,
      skillSection: sections.hookAuditor,
    }),
    a4BrollAuditor(anthropic, supabase, runId, {
      videoMap,
      frameDescriptions,
      guidelines,
      skillSection: sections.brollAuditor,
      transcript,
    }),
    a35Enabled
      ? a35HookVisionPass(anthropic, supabase, runId, {
          hookFrames: hookFramesRaw,
          transcript: transcript.substring(0, 2000),
          guidelines,
          videoMap,
        })
      : Promise.resolve(null),
    a45Enabled
      ? a45SubtitleQC(anthropic, supabase, runId, { frameDescriptions, transcript })
      : Promise.resolve(null),
  ]);

  const a3Result = a3Settled.status === 'fulfilled' ? a3Settled.value : null;
  const a4Result = a4Settled.status === 'fulfilled' ? a4Settled.value : null;
  const a35Result = a35Settled.status === 'fulfilled' ? a35Settled.value : null;
  const a45Result = a45Settled.status === 'fulfilled' ? a45Settled.value : null;
  if (a3Settled.status === 'rejected') console.error('[A3] FAILED:', a3Settled.reason?.message);
  if (a4Settled.status === 'rejected') console.error('[A4] FAILED:', a4Settled.reason?.message);
  if (a35Settled.status === 'rejected') console.error('[A3.5] FAILED:', a35Settled.reason?.message);
  if (a45Settled.status === 'rejected') console.error('[A4.5] FAILED:', a45Settled.reason?.message);

  const a3Directives = Array.isArray(a3Result?.parsed?.hook_directives) ? a3Result.parsed.hook_directives : [];
  const a35Directives = Array.isArray(a35Result?.parsed?.hook_directives) ? a35Result.parsed.hook_directives : [];
  // A3.5 en premier : ses directives (issues des pixels) priment au dédoublonnage A5
  const hookDirectives = [...a35Directives, ...a3Directives];
  const brollDirectives = Array.isArray(a4Result?.parsed?.broll_directives) ? a4Result.parsed.broll_directives : [];
  const subtitleIssues = Array.isArray(a45Result?.parsed?.subtitle_issues) ? a45Result.parsed.subtitle_issues : [];
  if (a3Result) metrics.agents.a3_hook_auditor = { tokensIn: a3Result.tokensIn, tokensOut: a3Result.tokensOut, duration_ms: a3Result.elapsed };
  if (a35Result) metrics.agents.a35_hook_vision = { tokensIn: a35Result.tokensIn, tokensOut: a35Result.tokensOut, duration_ms: a35Result.elapsed };
  if (a4Result) metrics.agents.a4_broll_auditor = { tokensIn: a4Result.tokensIn, tokensOut: a4Result.tokensOut, duration_ms: a4Result.elapsed };
  if (a45Result) metrics.agents.a45_subtitle_qc = { tokensIn: a45Result.tokensIn, tokensOut: a45Result.tokensOut, duration_ms: a45Result.elapsed };
  console.log(`[A3] ${a3Directives.length} hook directives${!a3Result ? ' (FAILED)' : ''}`);
  console.log(`[A3.5] ${a35Directives.length} vision directives${a35Enabled ? (!a35Result ? ' (FAILED)' : '') : ' (disabled)'}`);
  console.log(`[A4] ${brollDirectives.length} broll directives${!a4Result ? ' (FAILED)' : ''}`);
  console.log(`[A4.5] ${subtitleIssues.length} subtitle issues${a45Enabled ? (!a45Result ? ' (FAILED)' : '') : ' (disabled)'}`);

  if (verbose) {
    console.log('[A3 verbose]', JSON.stringify(hookDirectives, null, 2));
    console.log('[A4 verbose]', JSON.stringify(brollDirectives, null, 2));
  }

  // ── A5: QC Agent ────────────────────────────────────────────────────────
  console.log('\n── A5: QC Agent ─────────────────────────────────');
  const a5Result = await a5QC(anthropic, supabase, runId, {
    hookDirectives,
    brollDirectives,
    videoMap,
    skillSection: sections.qcAgent,
  });
  const qcOutput = a5Result.parsed || { score: 0, directives: [], major_issues: [] };
  metrics.agents.a5_qc = { tokensIn: a5Result.tokensIn, tokensOut: a5Result.tokensOut, duration_ms: a5Result.elapsed };
  console.log(`[A5] Score: ${qcOutput.score}/10 — ${qcOutput.directives?.length || 0} directives validated`);

  // ── A6: Formatter ───────────────────────────────────────────────────────
  console.log('\n── A6: Obsidian Formatter ────────────────────────');
  const a6Result = await a6Formatter(anthropic, supabase, runId, {
    qcOutput,
    videoMap,
    metadata: { clientName, clientSlug, videoName, version, take },
    subtitleIssues,
  });
  const markdown = a6Result.raw || '';
  metrics.agents.a6_formatter = { tokensIn: a6Result.tokensIn, tokensOut: a6Result.tokensOut, duration_ms: a6Result.elapsed };

  // ── Compute totals ──────────────────────────────────────────────────────
  const totalElapsed = Date.now() - t0;
  let totalTokensIn = 0, totalTokensOut = 0;
  for (const agent of Object.values(metrics.agents)) {
    totalTokensIn += agent.tokensIn || 0;
    totalTokensOut += agent.tokensOut || 0;
  }

  // Rough cost estimate (Sonnet: $3/$15 per 1M, Opus: $15/$75, Haiku: $0.80/$4)
  const costEstimate = (
    ((metrics.agents.a1_frame_describer?.tokensIn || 0) * 3 + (metrics.agents.a1_frame_describer?.tokensOut || 0) * 15) +
    ((metrics.agents.a2_cartographer?.tokensIn || 0) * 3 + (metrics.agents.a2_cartographer?.tokensOut || 0) * 15) +
    ((metrics.agents.a3_hook_auditor?.tokensIn || 0) * 15 + (metrics.agents.a3_hook_auditor?.tokensOut || 0) * 75) +
    ((metrics.agents.a35_hook_vision?.tokensIn || 0) * 15 + (metrics.agents.a35_hook_vision?.tokensOut || 0) * 75) +
    ((metrics.agents.a4_broll_auditor?.tokensIn || 0) * 15 + (metrics.agents.a4_broll_auditor?.tokensOut || 0) * 75) +
    ((metrics.agents.a45_subtitle_qc?.tokensIn || 0) * 0.8 + (metrics.agents.a45_subtitle_qc?.tokensOut || 0) * 4) +
    ((metrics.agents.a5_qc?.tokensIn || 0) * 3 + (metrics.agents.a5_qc?.tokensOut || 0) * 15) +
    ((metrics.agents.a6_formatter?.tokensIn || 0) * 0.8 + (metrics.agents.a6_formatter?.tokensOut || 0) * 4)
  ) / 1_000_000;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ✅ Pipeline terminé — ${(totalElapsed / 1000).toFixed(1)}s`);
  console.log(`  Score: ${qcOutput.score}/10 — ${qcOutput.directives?.length || 0} directives`);
  console.log(`  Tokens: ${totalTokensIn} in / ${totalTokensOut} out — ~$${costEstimate.toFixed(2)}`);
  console.log(`${'═'.repeat(60)}\n`);

  return {
    score: qcOutput.score,
    score_rationale: qcOutput.score_rationale,
    directives: qcOutput.directives || [],
    major_issues: qcOutput.major_issues || [],
    subtitle_issues: subtitleIssues,
    markdown,
    metadata: {
      duration_ms: totalElapsed,
      tokens_total: totalTokensIn + totalTokensOut,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      cost_estimate: parseFloat(costEstimate.toFixed(4)),
      agents: metrics.agents,
      video_duration_s: videoMap.duration_s,
      frames_count: frames.length,
      client: clientName,
    },
  };

  } finally {
    // ── Cleanup extracted bundle (frames + index.json) ──────────────────────
    if (bundlePath && !isBundle(videoPath)) {
      // Only cleanup if we extracted it (not if input was already a bundle)
      const parentDir = require('path').dirname(bundlePath);
      cleanupPath(parentDir);
    }
  }
}

module.exports = { runPipeline };
