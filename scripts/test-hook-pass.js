#!/usr/bin/env node
/**
 * Test standalone de A3.5 Hook Vision Pass sur des frames locales.
 *
 * Usage:
 *   node scripts/test-hook-pass.js --frames=/path/to/frames_dir --slug=yann-legallais [--transcript=/path/to/whisper.json]
 *
 * Les frames doivent être nommées de façon triable (f_01.jpg, f_02.jpg, ...)
 * à 0.5s d'intervalle à partir de 00:00.
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { getSupabase } = require('../lib/supabase');
const { loadClientGuidelines } = require('../lib/guidelines');
const { a35HookVisionPass } = require('../lib/agents');

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

async function main() {
  const framesDir = args.frames;
  const slug = args.slug || null;
  if (!framesDir || !fs.existsSync(framesDir)) {
    console.error('Usage: node scripts/test-hook-pass.js --frames=<dir> [--slug=<client>] [--transcript=<whisper.json>]');
    process.exit(1);
  }

  // Load frames
  const files = fs.readdirSync(framesDir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
  const hookFrames = files.map((f, i) => ({
    index: i,
    timecode: `00:${String(Math.floor(i * 0.5)).padStart(2, '0')}.${i % 2 === 0 ? '0' : '5'}`,
    timecode_s: i * 0.5,
    base64: fs.readFileSync(path.join(framesDir, f)).toString('base64'),
  }));
  console.log(`Frames: ${hookFrames.length} (0 → ${(hookFrames.length - 1) * 0.5}s)`);

  // Load transcript (whisper JSON)
  let transcript = '';
  if (args.transcript && fs.existsSync(args.transcript)) {
    const w = JSON.parse(fs.readFileSync(args.transcript, 'utf-8'));
    transcript = (w.segments || [])
      .map(s => `[${s.start.toFixed(1)}s → ${s.end.toFixed(1)}s] ${s.text.trim()}`)
      .join('\n');
    console.log(`Transcript: ${transcript.length} chars`);
  }

  // Load guidelines (base + client via 4-strategy matching)
  const supabase = getSupabase();
  const { guidelines, clientName } = await loadClientGuidelines(supabase, slug);
  console.log(`Guidelines: client="${clientName}" — ${guidelines.length} chars\n`);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const t0 = Date.now();
  const result = await a35HookVisionPass(anthropic, null, null, {
    hookFrames,
    transcript,
    guidelines,
    videoMap: {},
  });

  console.log(`\n═══ A3.5 RESULT (${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.tokensIn} in / ${result.tokensOut} out) ═══\n`);
  const directives = result.parsed?.hook_directives || [];
  if (!directives.length) {
    console.log('(aucune directive — hook conforme ou parsing KO)');
    console.log('RAW:', result.raw?.substring(0, 1000));
  }
  for (const d of directives) {
    console.log(`### ${d.timecode} | ${d.action}`);
    if (d.current_description) console.log(`Actuel : ${d.current_description}`);
    if (d.instruction) console.log(`→ ${d.instruction}`);
    if (d.ts_text) console.log(`TS proposé :\n\`\`\`\n${d.ts_text}\n\`\`\``);
    console.log('');
  }

  const cost = (result.tokensIn * 15 + result.tokensOut * 75) / 1e6;
  console.log(`Coût A3.5 (Opus) : ~$${cost.toFixed(3)}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
