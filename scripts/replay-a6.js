#!/usr/bin/env node
/**
 * Replay A6 (Formatter) for an existing run.
 *
 * Re-runs ONLY the A6 formatter agent on a previous run, using the qcOutput
 * (A5 output) and videoMap (A2 output) cached in Supabase ve_edit_agent_logs.
 *
 * Use this to iterate fast on the A6_SYSTEM prompt without re-running the full
 * pipeline (A1 vision is expensive). Each replay costs ~$0.001 (Haiku) and ~3s.
 *
 * Usage:
 *   node scripts/replay-a6.js <runId>            → markdown to stdout
 *   node scripts/replay-a6.js <runId> --diff     → diff vs original markdown
 *   node scripts/replay-a6.js latest             → use most recent run
 *   node scripts/replay-a6.js latest <client>    → most recent run for client
 *
 * Requires: SUPABASE_URL, SUPABASE_KEY, ANTHROPIC_API_KEY in .env
 */
require('dotenv').config({ override: true });

const { getSupabase } = require('../lib/supabase');
const { getAnthropicClient } = require('../lib/anthropic');
const { a6Formatter } = require('../lib/agents');
const { parseAgentJSON } = require('../lib/qc');

async function findRunId(supabase, arg, clientFilter) {
  if (arg && arg !== 'latest') return arg;

  let q = supabase
    .from('ve_edit_runs')
    .select('id, client_slug, video_name, version, take, status, created_at')
    .order('created_at', { ascending: false })
    .limit(1);
  if (clientFilter) q = q.eq('client_slug', clientFilter);

  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`Supabase query failed: ${error.message}`);
  if (!data) throw new Error(`No runs found${clientFilter ? ` for client "${clientFilter}"` : ''}`);

  console.error(`[replay-a6] Using latest run: ${data.id} (${data.client_slug} / ${data.video_name} / ${data.created_at})`);
  return data.id;
}

async function fetchRun(supabase, runId) {
  const { data: run, error: runErr } = await supabase
    .from('ve_edit_runs')
    .select('id, client_slug, video_name, version, take, score, markdown_output')
    .eq('id', runId)
    .maybeSingle();
  if (runErr) throw new Error(`Failed to fetch run: ${runErr.message}`);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const { data: logs, error: logErr } = await supabase
    .from('ve_edit_agent_logs')
    .select('agent_name, output_raw, status, created_at')
    .eq('run_id', runId)
    .order('created_at', { ascending: true });
  if (logErr) throw new Error(`Failed to fetch agent logs: ${logErr.message}`);
  if (!logs || logs.length === 0) throw new Error(`No agent logs found for run ${runId}`);

  // Pick the latest successful log per agent (each agent may have a "started" + "success" row)
  const byAgent = {};
  for (const log of logs) {
    if (log.status === 'started') continue;
    byAgent[log.agent_name] = log;
  }

  const a2 = byAgent['a2_cartographer'];
  const a5 = byAgent['a5_qc'];
  if (!a2) throw new Error(`Run ${runId} has no a2_cartographer log`);
  if (!a5) throw new Error(`Run ${runId} has no a5_qc log`);

  const videoMap = parseAgentJSON(a2.output_raw);
  const qcOutput = parseAgentJSON(a5.output_raw);
  if (!videoMap) throw new Error(`Failed to parse a2_cartographer output_raw as JSON`);
  if (!qcOutput) throw new Error(`Failed to parse a5_qc output_raw as JSON`);

  return { run, videoMap, qcOutput };
}

function diff(a, b) {
  const aLines = (a || '').split('\n');
  const bLines = (b || '').split('\n');
  const max = Math.max(aLines.length, bLines.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const A = aLines[i] ?? '';
    const B = bLines[i] ?? '';
    if (A === B) {
      out.push(`  ${A}`);
    } else {
      if (A) out.push(`- ${A}`);
      if (B) out.push(`+ ${B}`);
    }
  }
  return out.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/replay-a6.js <runId|latest> [client_slug] [--diff]');
    process.exit(1);
  }

  const showDiff = args.includes('--diff');
  const positional = args.filter(a => !a.startsWith('--'));
  const runArg = positional[0];
  const clientFilter = positional[1];

  const supabase = getSupabase();
  const anthropic = getAnthropicClient();
  if (!supabase) throw new Error('SUPABASE_URL / SUPABASE_KEY missing in .env');
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY missing in .env');

  const runId = await findRunId(supabase, runArg, clientFilter);
  console.error(`[replay-a6] Loading run ${runId} from Supabase...`);
  const { run, videoMap, qcOutput } = await fetchRun(supabase, runId);

  console.error(`[replay-a6] Run loaded: client=${run.client_slug}, video=${run.video_name}, score=${run.score}, directives=${qcOutput.directives?.length || 0}`);
  console.error(`[replay-a6] Calling A6 formatter...`);

  const t0 = Date.now();
  const a6Result = await a6Formatter(anthropic, /* supabase */ null, runId, {
    qcOutput,
    videoMap,
    metadata: {
      clientName: run.client_slug, // We don't re-fetch from client_guidelines for speed
      clientSlug: run.client_slug,
      videoName: run.video_name,
      version: run.version,
      take: run.take,
    },
  });
  const elapsed = Date.now() - t0;
  const markdown = a6Result.raw || '';

  console.error(`[replay-a6] A6 done in ${elapsed}ms — ${a6Result.tokensIn} in / ${a6Result.tokensOut} out`);
  console.error(`[replay-a6] ${'─'.repeat(60)}`);

  if (showDiff) {
    console.log(diff(run.markdown_output || '', markdown));
  } else {
    console.log(markdown);
  }
}

main().catch(err => {
  console.error(`[replay-a6] ERROR: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
