#!/usr/bin/env node
/**
 * Generate guidelines-edit.md from a BlueDot PPM transcript.
 *
 * Usage:
 *   node generate.js --slug romain-bazin
 *   node generate.js --slugs romain-bazin,catherine-tournut,julie-borgeaud
 *   node generate.js --all                          # all 456 (DANGEROUS — use --concurrency)
 *   [--concurrency 3] [--out ./out]
 *
 * For each slug, reads ../bluedot/out/{slug}.md, calls Claude Sonnet to generate
 * a guidelines-edit.md following the creation-guidelines skill template, and
 * writes the result to ./out/{slug}-edit.md.
 *
 * No DB enrichment in this version — transcript is the sole source.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), override: true });
const fs = require('fs');
const path = require('path');
const { getAnthropicClient } = require('../../lib/anthropic');
const { callClaude, MODELS } = require('../../lib/qc');

// ---------- args ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'bluedot', 'out');
const OUT_DIR = args.out ? path.resolve(args.out) : path.join(__dirname, 'out');
const CONCURRENCY = parseInt(args.concurrency || '3', 10);

let slugs = [];
if (args.slug) slugs = [args.slug];
else if (args.slugs) slugs = args.slugs.split(',').map((s) => s.trim()).filter(Boolean);
else if (args.all) {
  slugs = fs.readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'index.json')
    .map((f) => f.replace(/\.md$/, ''));
}

if (slugs.length === 0) {
  console.error('Usage: node generate.js --slug <slug> | --slugs a,b,c | --all');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- prompts ----------

const SYSTEM_PROMPT = `Tu es un expert en référentiel client pour une agence vidéo de personal branding (Agence Personnelle).

Ta mission : à partir d'un transcript brut d'un RDV éditorial entre un client et un Personal Brand Manager (PBM), tu produis le fichier \`guidelines-{slug}-edit.md\` — le référentiel de validation montage/visuel pour le skill VE Edit.

Ce fichier sert au monteur ET au validateur (skill ve-edit) pour savoir, pour ce client précis :
- Qui montrer en B-roll (ICP visuel)
- Quoi montrer / quoi NE JAMAIS montrer (univers visuel et interdits)
- Comment écrire les Titres Simples (TS)
- Quel parti pris émotionnel prendre au montage
- Quelles règles spécifiques à ce client respecter

# Méthode

1. **Lis attentivement le transcript** — c'est un RDV éditorial où le client parle de son métier, sa cible, ses valeurs, ses opinions, ses interdits, ses formats vidéo.
2. **Extrais ce qui est DIT explicitement** sur l'ICP, les visuels, les mots clés, les opinions tranchées, les choses à ne jamais faire.
3. **Ne devine pas** ce qui n'est pas dit. Si l'info manque pour une section, écris explicitement "_Non précisé dans le RDV — à valider avec le client_".
4. **Sois opérationnel** : un monteur qui lit ce fichier doit pouvoir travailler sans poser de questions.
5. **Cite le client** quand c'est utile : si le client dit "je ne veux jamais voir X", reprends ses mots.

# Format de sortie

Tu produis UN seul fichier markdown complet, prêt à copier-coller dans Obsidian. Structure exacte ci-dessous. Remplis chaque section avec du contenu spécifique au client (pas de placeholders).

\`\`\`markdown
---
writer_system: cowork
writer_agent: claude
created_at: {{date du jour}}
type: guidelines-edit
client: "{{Prénom Nom}}"
secteur: "{{secteur du client}}"
project: Agence Personnelle
source: bluedot-transcript
---

# Guidelines EDIT — {{Prénom Nom}}

## 1. Identité client

| Champ | Contenu |
|---|---|
| **Nom** | {{Prénom Nom}} |
| **Métier / Positionnement** | {{en 1 phrase}} |
| **Secteur** | {{secteur}} |

---

## 2. ICP — Représentation visuelle

| Champ | Contenu |
|---|---|
| **Profil cible** | {{2-3 phrases — qui regarde}} |
| **Apparence visuelle cible** | {{âge, genre, style, contexte}} |
| **Ce qu'on montre comme "eux"** | {{exemples de plans B-roll concrets}} |
| **Ce qu'on ne montre JAMAIS comme "eux"** | {{anti-exemples}} |

---

## 3. Univers visuel — CE QU'ON MONTRE

### 3a. Plans du speaker
| Situation | Description | Quand l'utiliser |
|---|---|---|
| {{...}} | {{...}} | {{...}} |

### 3b. Plans de coupe par thème
| Thème récurrent | Plans adaptés | Durée max |
|---|---|---|
| {{...}} | {{...}} | {{...}} |

---

## 4. Univers visuel — CE QU'ON NE MONTRE PAS

| Interdit | Raison | Alternative |
|---|---|---|
| {{...}} | {{...}} | {{...}} |

---

## 5. Titre Simple (TS) — Direction créative

| Champ | Contenu |
|---|---|
| **Registre de langue** | {{...}} |
| **Mots-clés puissants pour ce client** | {{...}} |
| **Mots interdits dans le TS** | {{...}} |

### Exemples de TS par format
| Format vidéo | TS ✅ qui marche | TS ❌ à éviter | Pourquoi |
|---|---|---|---|
| {{...}} | {{...}} | {{...}} | {{...}} |

---

## 6. Hook visuel — Règles spécifiques

| Règle | Application pour ce client |
|---|---|
| **Speaker visible 0-3s** | {{...}} |
| **Élément visuel identifiable** | {{...}} |
| **Format compris en 3s** | {{...}} |
| **Rotoscopie dans le hook** | {{Autorisée / Pas pour ce client}} |

---

## 7. Plans IA custom

| Situation | Utilisation |
|---|---|
| **Visage du client en contexte** | {{...}} |
| **Régénération de plans interdits** | {{...}} |
| **Style IA** | {{...}} |

---

## 8. Musique

| Type de vidéo | Ton musical | Ce qu'on évite |
|---|---|---|
| {{...}} | {{...}} | {{...}} |

---

## 9. Montage — Parti pris émotionnel

| Moment dans la vidéo | Émotion à faire sentir | Outils montage |
|---|---|---|
| {{...}} | {{...}} | {{...}} |

---

## 10. Style de montage global

| Paramètre | Valeur pour ce client |
|---|---|
| **Densité de B-roll** | {{Légère / Moyenne / Dense}} |
| **Transitions** | {{...}} |
| **Sous-titres** | {{...}} |
| **Rythme** | {{...}} |
| **Over-produced ?** | {{...}} |

---

## 11. Règles par type de vidéo

Pour chaque format récurrent identifié dans le RDV, crée une sous-section.

#### Vidéos "{{Format X}}"
| Élément | Règle |
|---|---|
| **Plans de coupe** | {{...}} |
| **TS direction** | {{...}} |
| **Montage prend parti** | {{...}} |

---

## 12. Récap express monteur

| Règle | Application |
|---|---|
| ICP visuel | {{1 ligne}} |
| B-roll | {{1 ligne}} |
| Speaker | {{1 ligne}} |
| TS | {{1 mot}} |
| Musique | {{1 mot}} |
| Interdit n°1 | {{le truc le plus critique}} |
\`\`\`

# Règles strictes

- Retourne UNIQUEMENT le markdown final (pas de préambule, pas d'explication, pas de \`\`\`markdown wrapper).
- Si une info manque, écris "_Non précisé dans le RDV_" — n'invente jamais.
- Sois exhaustif sur les sections 4 (interdits) et 9 (parti pris émotionnel) — c'est ce qui rend le fichier opérationnel.
- Le client name dans le frontmatter doit être correctement capitalisé (pas en SLUG).`;

// ---------- helpers ----------

function extractTitle(md) {
  const m = md.match(/^# (.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function buildClientName(title) {
  // "RDV Éditorial PRSNL - Romain BAZIN" → "Romain Bazin"
  let t = title;
  t = t.replace(/^RDV\s+Éditorial\s+(PRSNL\s+)?-\s*/i, '');
  t = t.replace(/\s*x\s*agence\s*personnelle\s*$/i, '');
  // Title-case the words
  return t
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function generateOne(anthropic, slug) {
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${slug}.md`);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(`Transcript not found: ${transcriptPath}`);
  }
  const md = fs.readFileSync(transcriptPath, 'utf-8');
  const title = extractTitle(md);
  const clientName = buildClientName(title);
  const today = new Date().toISOString().slice(0, 10);

  const userContent = `# Brief

- **Slug client** : ${slug}
- **Nom client (déduit du titre BlueDot)** : ${clientName}
- **Date du jour** : ${today}

---

# Transcript brut du RDV éditorial (BlueDot)

${md}

---

Génère maintenant le fichier \`guidelines-${slug}-edit.md\` complet en suivant le template.`;

  const result = await callClaude(anthropic, {
    systemPrompt: SYSTEM_PROMPT,
    content: userContent,
    model: MODELS.ANALYSIS, // claude-sonnet-4-6
    maxTokens: 8000,
    temperature: 0.3,
  });

  // Strip eventual ```markdown wrapper
  let output = result.rawText.trim();
  const wrap = output.match(/^```(?:markdown)?\s*([\s\S]*?)```\s*$/);
  if (wrap) output = wrap[1].trim();

  const outPath = path.join(OUT_DIR, `${slug}-edit.md`);
  fs.writeFileSync(outPath, output, 'utf-8');

  return {
    slug,
    clientName,
    file: outPath,
    chars: output.length,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    elapsedMs: result.elapsed,
  };
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
        results[i] = { slug: items[i], error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// ---------- main ----------
(async () => {
  const anthropic = getAnthropicClient();
  if (!anthropic) {
    console.error('Anthropic client unavailable — check ANTHROPIC_API_KEY');
    process.exit(1);
  }

  console.log(`[1/2] Generating ${slugs.length} guidelines (concurrency=${CONCURRENCY})...`);
  const t0 = Date.now();

  let done = 0;
  const results = await pMapLimit(slugs, CONCURRENCY, async (slug) => {
    const r = await generateOne(anthropic, slug);
    done += 1;
    process.stdout.write(`  [${done}/${slugs.length}] ${slug} → ${r.chars}c, ${r.tokensIn}/${r.tokensOut}t, ${r.elapsedMs}ms\n`);
    return r;
  });

  const elapsed = Date.now() - t0;
  const ok = results.filter((r) => r && !r.error);
  const failed = results.filter((r) => r && r.error);
  const totalIn = ok.reduce((a, r) => a + (r.tokensIn || 0), 0);
  const totalOut = ok.reduce((a, r) => a + (r.tokensOut || 0), 0);
  // Sonnet 4.6: $3/M in, $15/M out
  const cost = (totalIn * 3 + totalOut * 15) / 1_000_000;

  console.log(`\n[2/2] Done in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  ok: ${ok.length} / failed: ${failed.length}`);
  console.log(`  tokens: ${totalIn} in / ${totalOut} out`);
  console.log(`  cost: $${cost.toFixed(4)}`);
  console.log(`  output: ${OUT_DIR}`);
  if (failed.length) console.log('Failures:', failed);

  // Write index
  fs.writeFileSync(
    path.join(OUT_DIR, 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), totalMs: elapsed, ok, failed, cost }, null, 2)
  );
})().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
