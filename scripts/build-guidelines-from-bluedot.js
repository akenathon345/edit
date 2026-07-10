#!/usr/bin/env node
/**
 * Build guidelines EDIT from BlueDot PPM transcripts.
 *
 * For each entry in bluedot_mapping.json :
 *   1. Fetch BlueDot preview page (public, no auth)
 *   2. Parse __NEXT_DATA__ to extract transcription array
 *   3. Reconstruct text by speaker (paragraph blocks)
 *   4. Call Claude Opus with the Avi Bitton template + transcript
 *   5. Write file to vault + upsert to Supabase client_guidelines
 *
 * Usage:
 *   node scripts/build-guidelines-from-bluedot.js                # all
 *   node scripts/build-guidelines-from-bluedot.js --slug=jonathan-baruchel
 *   node scripts/build-guidelines-from-bluedot.js --limit=5     # first 5
 *   node scripts/build-guidelines-from-bluedot.js --dry-run     # no writes
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { getSupabase } = require('../lib/supabase');

const MAPPING_PATH = path.join(__dirname, 'bluedot_mapping.json');
const VAULT_BASE = '/Users/clementsaintbeat/Documents/vault/10_CANON/Clients';
const TEMPLATE_PATH = '/Users/clementsaintbeat/Documents/Claude/10_CANON/Clients/Avi Bitton/guidelines-avi-bitton-edit.md';

const args = process.argv.slice(2);
const argMap = Object.fromEntries(args.map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const onlySlug = argMap.slug;
const limit = argMap.limit ? parseInt(argMap.limit, 10) : null;
const dryRun = argMap['dry-run'] === true;
const startFrom = argMap.start ? parseInt(argMap.start, 10) : 0;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = getSupabase();

// ── Helpers ──────────────────────────────────────────────────────────────

async function fetchBluedotTranscript(videoId) {
  const resp = await fetch(`https://app.bluedothq.com/preview/${videoId}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36' }
  });
  if (!resp.ok) throw new Error(`BlueDot HTTP ${resp.status}`);
  const html = await resp.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No __NEXT_DATA__ found');
  const data = JSON.parse(m[1]);
  const video = data.props?.pageProps?.video;
  if (!video) throw new Error('No video data');
  const transcription = video.videoTranscription?.transcription;
  if (!Array.isArray(transcription)) throw new Error('No transcription array');

  // Reconstruct by paragraph + speaker
  const blocks = [];
  let cur = null;
  for (const w of transcription) {
    if (w.silence) continue;
    if (!cur || cur.speaker !== w.speakerTag || cur.paragraph !== w.paragraph) {
      if (cur) blocks.push(cur);
      cur = { speaker: w.speakerTag, paragraph: w.paragraph, text: [], start: w.start };
    }
    cur.text.push(w.text);
  }
  if (cur) blocks.push(cur);

  const text = blocks
    .map(b => `**${b.speaker}**\n${b.text.join(' ')}`)
    .join('\n\n');

  return { title: video.title, text, wordsCount: transcription.length };
}

function nameFromSlug(slug) {
  return slug.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function buildPrompt(clientName, transcript, template) {
  return `Tu es un expert qui produit les guidelines EDIT pour les vidéos d'Agence Personnelle.

Voici le template de référence (Avi Bitton) — RESPECTE SCRUPULEUSEMENT cette structure (sections 1 → 11, tableaux, format markdown, ton) :

<template>
${template}
</template>

Voici le transcript du PPM (RDV éditorial) entre la Personal Brand Manager et le client ${clientName} :

<transcript>
${transcript}
</transcript>

Produis maintenant le fichier de guidelines EDIT pour ${clientName}, en suivant exactement la structure du template, mais avec le contenu SPÉCIFIQUE à ${clientName} extrait du transcript :

RÈGLES :
- Frontmatter YAML en tête (writer_system, writer_agent, created_at: 2026-05-11, type: guidelines-edit, client, secteur, project: Agence Personnelle)
- Section 1 Identité : métier, positionnement, prix si mentionnés
- Section 2 Univers visuel : tenue, palette, lumière, mood — déduis du transcript ou laisse des valeurs raisonnables si non mentionnées
- Section 3 ICP : OBLIGATOIRE, extrait depuis le transcript (profil cible, apparence, ce qu'on montre / ce qu'on ne montre pas comme "eux")
- Section 4 B-roll par thème : adapte aux thèmes du métier
- Section 5 B-roll interdits : extrait les zones rouges, concurrents nommés, sujets à éviter
- Section 6 TS : registre de langue, mots interdits
- Section 7 Hook visuel : règles spécifiques
- Section 8 Plans IA custom
- Section 11 Style de montage : densité B-roll, transitions, sous-titres, rythme

SI une info n'est pas dans le transcript, mets une valeur raisonnable et ajoute un commentaire \`<!-- à confirmer -->\` à côté.

Réponds UNIQUEMENT avec le contenu markdown du fichier, rien d'autre. PAS de bloc \`\`\`markdown autour.`;
}

async function generateGuidelines(clientName, transcript, template) {
  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: buildPrompt(clientName, transcript, template) }],
  });
  const text = resp.content.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('No text content in Anthropic response');
  return {
    content: text.trim(),
    tokens_in: resp.usage.input_tokens,
    tokens_out: resp.usage.output_tokens,
  };
}

function extractICP(markdown) {
  const m = markdown.match(/##\s*3\.\s*ICP[\s\S]*?\|\s*\*\*Profil cible\*\*\s*\|\s*([^|]+)\s*\|/);
  return m ? m[1].trim() : '';
}

async function writeToVault(clientName, slug, content) {
  const dir = path.join(VAULT_BASE, clientName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `guidelines-${slug}-edit.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

async function upsertSupabase(slug, clientName, icp, content) {
  if (!supabase) throw new Error('Supabase not configured');
  const { error } = await supabase
    .from('client_guidelines')
    .upsert({
      client_slug: slug,
      client_name: clientName,
      icp: icp || '',
      guidelines_content: content,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'client_slug' });
  if (error) throw new Error(`Supabase: ${error.message}`);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const mapping = JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf-8'));
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');

  let queue = mapping;
  if (onlySlug) queue = mapping.filter(e => e.slug === onlySlug);
  if (startFrom) queue = queue.slice(startFrom);
  if (limit) queue = queue.slice(0, limit);

  console.log(`\n📋 Processing ${queue.length} client(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

  const summary = { ok: [], failed: [], skipped: [] };

  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    const clientName = nameFromSlug(entry.slug);
    const tag = `[${i + 1}/${queue.length}] ${entry.slug}`;

    try {
      console.log(`${tag} → fetching BlueDot transcript...`);
      const { text, wordsCount } = await fetchBluedotTranscript(entry.id);
      console.log(`${tag} → transcript: ${wordsCount} words, ${text.length} chars`);

      if (text.length < 500) {
        console.log(`${tag} ⚠️  transcript too short, skipping`);
        summary.skipped.push({ slug: entry.slug, reason: 'transcript too short' });
        continue;
      }

      console.log(`${tag} → calling Claude Opus...`);
      const { content, tokens_in, tokens_out } = await generateGuidelines(clientName, text, template);
      console.log(`${tag} → generated ${content.length} chars (${tokens_in}→${tokens_out} tokens)`);

      const icp = extractICP(content);

      if (dryRun) {
        console.log(`${tag} [DRY] would write to vault + supabase`);
        const previewPath = path.join('/tmp', `preview-${entry.slug}.md`);
        fs.writeFileSync(previewPath, content, 'utf-8');
        console.log(`${tag} preview saved to ${previewPath}`);
      } else {
        const filePath = await writeToVault(clientName, entry.slug, content);
        console.log(`${tag} ✓ vault: ${filePath}`);
        await upsertSupabase(entry.slug, clientName, icp, content);
        console.log(`${tag} ✓ supabase upserted`);
      }

      summary.ok.push({ slug: entry.slug, tokens_in, tokens_out, icp });
    } catch (err) {
      console.error(`${tag} ❌ ${err.message}`);
      summary.failed.push({ slug: entry.slug, error: err.message });
    }
  }

  console.log('\n══════════════════════════════════');
  console.log(`✅ Success: ${summary.ok.length}`);
  console.log(`⚠️  Skipped: ${summary.skipped.length}`);
  console.log(`❌ Failed:  ${summary.failed.length}`);
  if (summary.failed.length) {
    console.log('\nFailures:');
    summary.failed.forEach(f => console.log(`  - ${f.slug}: ${f.error}`));
  }
  const totalTokens = summary.ok.reduce((s, x) => s + x.tokens_in + x.tokens_out, 0);
  console.log(`\nTotal tokens: ${totalTokens.toLocaleString()}`);
  console.log(`Estimated cost: $${(totalTokens / 1e6 * 15).toFixed(2)} (rough)`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
