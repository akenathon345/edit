const { execAgent, MODELS } = require('./qc');

// ── Helpers ────────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatTimecode(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const sStr = s % 1 === 0 ? s.toFixed(0).padStart(2, '0') : s.toFixed(1).padStart(4, '0');
  return m > 0 ? `${m}:${sStr}` : `00:${sStr}`;
}

// ── A1: FRAME DESCRIBER ───────────────────────────────────────────────────
// Seul agent qui voit les images. Batches de 20 frames en parallele.
// Output: JSON array de descriptions structurees par frame.

const A1_SYSTEM = `Tu es un analyste visuel de montage vidéo. Tu reçois des frames extraites d'une vidéo courte (Reels/TikTok/Shorts) à raison d'1 frame toutes les 0.5 secondes.

Pour CHAQUE frame, produis une description structurée en JSON.

INSTRUCTIONS :
- Observe CHAQUE frame individuellement, ne saute rien
- Identifie si le speaker est visible (visage à l'écran)
- Repère les Titres Simples (TS) : texte en gros sur l'écran, souvent en blocs avec des CAPS
- Repère les sous-titres (texte plus petit en bas)
- Les frames noires sont des séparateurs de multi-hooks, pas des erreurs
- Note si le plan contient du mouvement ou est statique
- Identifie les éléments reconnaissables (logos, visages connus, produits)

SORTIE : un JSON array. Chaque élément :
{
  "index": <int>,
  "timecode": "<MM:SS.s>",
  "type": "speaker" | "broll" | "black_frame" | "rotoscopy" | "pip",
  "speaker_visible": <bool>,
  "ts_text": "<texte du TS ou null>",
  "subtitle_text": "<texte sous-titres ou null>",
  "broll_subject": "<description courte du B-roll ou null>",
  "movement": <bool>,
  "identifiable_elements": [<string>],
  "description": "<description libre en 1 phrase>"
}

Retourne UNIQUEMENT le JSON array, rien d'autre.`;

async function a1FrameDescriber(anthropic, supabase, runId, frames) {
  const BATCH_SIZE = 20;
  const batches = chunk(frames, BATCH_SIZE);

  console.log(`[A1] ${frames.length} frames → ${batches.length} batches de ${BATCH_SIZE}`);

  const batchSettled = await Promise.allSettled(batches.map(async (batch, batchIdx) => {
    // Build multimodal content
    const content = [];
    for (const frame of batch) {
      // Detect actual image type from base64 magic bytes
      const buf = Buffer.from(frame.base64, 'base64');
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const mediaType = isPng ? 'image/png' : 'image/jpeg';
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: frame.base64 },
      });
      content.push({
        type: 'text',
        text: `Frame ${frame.index} — ${frame.timecode} — subtitle: "${frame.spoken_text || ''}"`,
      });
    }

    const result = await execAgent(anthropic, supabase, {
      runId,
      name: `a1_frame_describer_batch${batchIdx}`,
      systemPrompt: A1_SYSTEM,
      content,
      maxTokens: 4000,
      model: MODELS.VISION,
      temperature: 0.1,
      expectedShape: '[{ "index": 0, "timecode": "00:00", "type": "speaker", "speaker_visible": true, "ts_text": null, "subtitle_text": "...", "broll_subject": null, "movement": false, "identifiable_elements": [], "description": "..." }]',
    });

    return result;
  }));

  // Merge all batch results (resilient — partial results survive)
  const allFrameDescriptions = [];
  let totalTokensIn = 0, totalTokensOut = 0, totalElapsed = 0;
  let failedBatches = 0;

  for (let i = 0; i < batchSettled.length; i++) {
    const settled = batchSettled[i];
    if (settled.status === 'fulfilled') {
      const result = settled.value;
      if (result.parsed && Array.isArray(result.parsed)) {
        allFrameDescriptions.push(...result.parsed);
      }
      totalTokensIn += result.tokensIn;
      totalTokensOut += result.tokensOut;
      totalElapsed = Math.max(totalElapsed, result.elapsed);
    } else {
      failedBatches++;
      console.error(`[A1] Batch ${i} FAILED:`, settled.reason?.message);
    }
  }

  if (failedBatches > 0) {
    console.warn(`[A1] ${failedBatches}/${batches.length} batches failed — continuing with partial results`);
  }

  return {
    frameDescriptions: allFrameDescriptions,
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    elapsed: totalElapsed,
  };
}

// ── A2: CARTOGRAPHER ──────────────────────────────────────────────────────
// Construit la carte de la vidéo à partir des descriptions frames + transcription.
// Output: video map structurée (hooks, B-roll, phases, ICP).

const A2_SYSTEM = `Tu es un cartographe de vidéos courtes (Reels/TikTok/Shorts). Tu reçois :
1. Les descriptions de chaque frame de la vidéo (une frame toutes les 0.5s)
2. La transcription complète avec timecodes
3. Un hint sur le client et son ICP (client idéal)

Ton travail : construire une CARTE STRUCTURÉE de la vidéo.

INSTRUCTIONS :
1. MULTI-HOOKS : détecte les frames noires en début de vidéo qui séparent les accroches alternatives. Identifie MH1, MH2, MH3. Si pas de frames noires = 1 seul hook.
2. TRANSITION hook → corps : le moment où le cadrage change (plus large, TS disparaît, etc.)
3. PLANS DE COUPE : liste TOUS les moments où le speaker n'est pas visible (B-roll), avec timecode de début, durée estimée, et si le plan est statique ou en mouvement.
4. ICP : à qui parle cette vidéo ? Quel est le client idéal ?
5. PHASES : découpe la vidéo en phases (hook, consolidation, corps, conclusion/CTA)

SORTIE JSON :
{
  "duration_s": <float>,
  "multi_hooks": [
    { "id": "MH1", "start_s": 0, "end_s": 4.5, "ts_text": "...", "description": "..." }
  ],
  "hook_to_body_transition_s": <float>,
  "broll_plans": [
    { "start_s": <float>, "end_s": <float>, "duration_s": <float>, "description": "...", "static": <bool>, "broll_subject": "..." }
  ],
  "icp": "<description de l'ICP>",
  "phases": [
    { "name": "hook|consolidation|corps|conclusion|cta", "start_s": <float>, "end_s": <float> }
  ]
}

Retourne UNIQUEMENT le JSON, rien d'autre.`;

async function a2Cartographer(anthropic, supabase, runId, { frameDescriptions, transcript, icpHint, skillSection }) {
  const content = `RÉFÉRENCE MÉTHODOLOGIQUE :
${skillSection}

DESCRIPTIONS DES FRAMES :
${JSON.stringify(frameDescriptions, null, 1)}

TRANSCRIPTION COMPLÈTE :
${transcript}

${icpHint ? `HINT CLIENT / ICP :\n${icpHint}` : ''}

Construis la carte structurée de cette vidéo.`;

  const result = await execAgent(anthropic, supabase, {
    runId,
    name: 'a2_cartographer',
    systemPrompt: A2_SYSTEM,
    content,
    maxTokens: 3000,
    model: MODELS.ANALYSIS,
    temperature: 0.2,
    expectedShape: '{ "duration_s": 30, "multi_hooks": [...], "hook_to_body_transition_s": 5, "broll_plans": [...], "icp": "...", "phases": [...] }',
  });

  return result;
}

// ── A3: HOOK AUDITOR ──────────────────────────────────────────────────────
// Analyse les hooks et produit des directives spécifiques.

const A3_SYSTEM = `Tu es un Virality Expert Édit (VE Edit) senior spécialisé dans les HOOKS visuels.

Tu analyses UNIQUEMENT la partie hook de la vidéo (0 à ~5-6 secondes de chaque hook) et tu produis des DIRECTIVES DE MONTAGE timecodées.

Tu ne fais PAS d'observations. Tu fais des CHOIX. Le monteur est un stagiaire — chaque directive doit être exécutable sans réfléchir.

RÈGLES CRITIQUES :
- Le speaker DOIT être visible dans les 3 premières secondes de chaque hook
- Le Titre Simple (TS) doit créer de la CURIOSITÉ, pas décrire le sujet
- Le TS est en BLOCS avec CAPS sur les mots importants
- Le TS ne répète JAMAIS ce que le speaker dit à l'oral
- Le FORMAT de la vidéo doit être compris en 3 secondes (tier list, débunk, top 3...)
- Le TS reste continu (pas de disparition/réapparition)
- Durée du TS : 4-6s par hook, jamais 10s

RÈGLE TS ABSOLUE :
- UNE SEULE suggestion de TS par vidéo, toujours au tout début (timecode 00:00)
- JAMAIS 2 TS différents sur des timecodes successifs
- Si le TS actuel est correct, ne pas en proposer un autre

TOLÉRANCE MARQUE CLIENT :
- La transcription audio (Whisper) peut mal orthographier la marque du client. Ex : "EZAK" peut apparaître comme "HEYZACK", "HeyZack", "Hey Zack", etc.
- AVANT de flagger un logo/marque, vérifie si c'est une variante phonétique de la marque du client mentionnée dans les guidelines.
- Si c'est la marque du client → ce n'est PAS un concurrent.

LES 5 NIVEAUX DE DIRECTIVE :
1. VIRER → supprimer le plan, revenir sur le speaker
2. CHANGER → remplacer par un plan précis : QUI + OÙ + QUOI + COMBIEN (durée)
3. PASSER EN ROTOSCOPIE → le plan passe derrière le speaker au premier plan
4. RACCOURCIR → durée cible en secondes
5. CHANGER TS → texte exact du nouveau TS, avec blocs et caps

FORMAT : UNIQUEMENT les points à corriger, pas les plans qui sont bons.
Chaque directive : timecode → ACTION. + description + instruction concrète.

SORTIE JSON :
{
  "hook_directives": [
    {
      "timecode": "00:00-00:03",
      "action": "VIRER|CHANGER|ROTOSCOPIE|RACCOURCIR|CHANGER_TS|AJOUTER_TS",
      "current_description": "ce qui est actuellement visible",
      "instruction": "l'instruction concrète pour le monteur",
      "ts_text": "texte du nouveau TS si applicable"
    }
  ]
}`;

async function a3HookAuditor(anthropic, supabase, runId, { videoMap, frameDescriptions, guidelines, skillSection }) {
  // Filter frame descriptions to hook zone only (0 to ~10s)
  const hookEndS = (videoMap.hook_to_body_transition_s || 10) + 2;
  const hookFrames = frameDescriptions.filter(f => {
    const t = parseFloat(f.timecode) || (f.index * 0.5);
    return t <= hookEndS;
  });

  const content = `RÈGLES VE EDIT — HOOK VISUEL + TITRE SIMPLE :
${skillSection}

GUIDELINES CLIENT :
${guidelines}

CARTE DE LA VIDÉO (hooks) :
${JSON.stringify(videoMap.multi_hooks, null, 1)}

PHASES :
${JSON.stringify(videoMap.phases?.filter(p => p.name === 'hook' || p.name === 'consolidation'), null, 1)}

DESCRIPTIONS DES FRAMES (zone hook 0-${hookEndS}s) :
${JSON.stringify(hookFrames, null, 1)}

ICP : ${videoMap.icp}

Produis les directives de montage pour le hook. UNIQUEMENT les corrections nécessaires.`;

  return await execAgent(anthropic, supabase, {
    runId,
    name: 'a3_hook_auditor',
    systemPrompt: A3_SYSTEM,
    content,
    maxTokens: 3000,
    model: MODELS.AUDIT,
    temperature: 0.3,
    expectedShape: '{ "hook_directives": [{ "timecode": "00:00-00:03", "action": "CHANGER_TS", "current_description": "...", "instruction": "...", "ts_text": "..." }] }',
  });
}

// ── A4: BROLL AUDITOR ─────────────────────────────────────────────────────
// Analyse tous les plans de coupe et produit des directives.

const A4_SYSTEM = `Tu es un Virality Expert Édit (VE Edit) senior spécialisé dans les PLANS DE COUPE (B-roll).

Tu analyses TOUS les plans de coupe de la vidéo et tu produis des DIRECTIVES DE MONTAGE timecodées.

Tu ne fais PAS d'observations. Tu fais des CHOIX. Le monteur est un stagiaire.

RÈGLES CRITIQUES B-ROLL :
- Plan statique : 1 seconde MAX
- Plan avec mouvement : 1.5 secondes MAX
- Chaque plan doit AIDER la compréhension, pas juste "habiller"
- Pas d'illustration littérale des métaphores
- Cohérence ICP : les personnes montrées doivent correspondre au client idéal
- Contexte cohérent avec le sujet (restaurant étoilé ≠ Hippopotamus)
- Favoriser les plans avec du mouvement

TOLÉRANCE MARQUE CLIENT :
- La transcription audio (Whisper) peut mal orthographier la marque du client. Ex : "EZAK" peut apparaître comme "HEYZACK", "HeyZack", "Hey Zack", etc.
- AVANT de flagger un logo/marque comme concurrent, vérifie si c'est une variante phonétique de la marque du client mentionnée dans les guidelines.
- Si c'est la marque du client (même mal transcrite) → ce n'est PAS un concurrent, ne pas demander de virer/flouter.

VISUELS INTERDITS :
- Billets, pièces, argent en espèces, porte-monnaie vide
- Logos de marques CONCURRENTES (flouter ou IA avec 10% variation) — attention : ne pas confondre avec la marque du client mal transcrite
- Contenu TikTok français identifiable (utiliser US/RU/CN)
- Plans compromettants légalement

PLANS IA :
- Si le visage du speaker est composité dans une scène IA = POSITIF, pas du stock
- Le valider, pas le flaguer

EXPRESSIVITÉ :
- Aux moments d'émotion dans la voix, le montage doit revenir sur le speaker
- Pas de B-roll pendant les moments forts du speaker

MONTAGE PREND PARTI :
- Arnaque → SFX, riser, coupe rapide
- Succès → musique qui monte, émerveillement

LES 5 NIVEAUX DE DIRECTIVE :
1. VIRER → supprimer le plan, revenir sur le speaker
2. CHANGER → QUI + OÙ + QUOI + COMBIEN (durée). Description = mots-clés stock Pexels/Artgrid
3. PASSER EN ROTOSCOPIE → speaker devant, plan derrière
4. RACCOURCIR → durée cible en secondes
5. CHANGER TS → (rarement utilisé par A4)

FORMAT : UNIQUEMENT les points à corriger.

SORTIE JSON :
{
  "broll_directives": [
    {
      "timecode": "00:07-00:09.5",
      "action": "VIRER|CHANGER|ROTOSCOPIE|RACCOURCIR",
      "current_description": "ce qui est actuellement visible",
      "instruction": "l'instruction concrète pour le monteur"
    }
  ]
}`;

async function a4BrollAuditor(anthropic, supabase, runId, { videoMap, frameDescriptions, guidelines, skillSection }) {
  const content = `RÈGLES VE EDIT — B-ROLL / INTERDITS / IA / EXPRESSIVITÉ / MONTAGE :
${skillSection}

GUIDELINES CLIENT :
${guidelines}

CARTE DE LA VIDÉO (B-roll plans) :
${JSON.stringify(videoMap.broll_plans, null, 1)}

ICP : ${videoMap.icp}

TOUTES LES DESCRIPTIONS DES FRAMES :
${JSON.stringify(frameDescriptions, null, 1)}

Produis les directives de montage pour TOUS les plans de coupe. UNIQUEMENT les corrections nécessaires.`;

  return await execAgent(anthropic, supabase, {
    runId,
    name: 'a4_broll_auditor',
    systemPrompt: A4_SYSTEM,
    content,
    maxTokens: 4000,
    model: MODELS.AUDIT,
    temperature: 0.3,
    expectedShape: '{ "broll_directives": [{ "timecode": "00:07-00:09.5", "action": "RACCOURCIR", "current_description": "...", "instruction": "..." }] }',
  });
}

// ── A5: QC AGENT ──────────────────────────────────────────────────────────
// Valide, deduplique, ordonne les directives. Attribue un score.

const A5_SYSTEM = `Tu es un Quality Controller (QC) senior pour le montage vidéo. Tu reçois des directives de montage produites par deux auditeurs (hook + B-roll) et tu dois les VALIDER et NETTOYER.

TON JOB :
1. VÉRIFIER chaque directive :
   - Pas de "si possible" → remplacer par une directive ferme
   - Pas de descriptions vagues ("un plan business") → exiger QUI/OÙ/QUOI/COMBIEN
   - Pas de "GARDER" → supprimer (le monteur ne voit que les corrections)
   - Pas de plusieurs options → un seul choix
   - "PASSER en rotoscopie" pas "GARDER en rotoscopie"
   - Chaque CHANGER doit décrire le plan exact (mots-clés stock)

2. FILTRE RACCOURCIR : les directives "RACCOURCIR" ne sont pertinentes que pour les plans de **plus de 2 secondes**. Si un plan dure 2s ou moins, SUPPRIMER la directive RACCOURCIR (le plan est déjà court).

3. FILTRE TS : il ne doit y avoir qu'**UNE SEULE directive CHANGER_TS ou AJOUTER_TS** dans toute la sortie, et elle doit être au timecode le plus proche de 00:00. S'il y en a plusieurs, garder uniquement la première (la plus proche du début) et SUPPRIMER les autres.

3. DÉDUPLICATION : si hook et B-roll ont produit des directives sur le même timecode, fusionner

5. SÉLECTIVITÉ : garde UNIQUEMENT les directives à fort impact. Le monteur ne veut pas 15 retours dont 10 mineurs — il veut les 5-8 corrections qui changent vraiment la vidéo. En cas de doute, SUPPRIMER la directive.

6. ORDRE CHRONOLOGIQUE : trier toutes les directives par timecode croissant

7. TOLÉRANCE MARQUE : la transcription audio peut mal orthographier la marque du client (ex : "EZAK" → "HEYZACK"). Si une directive demande de virer/flouter ce qui est en fait la marque du client, SUPPRIMER cette directive.

8. SCORE /10 : évaluer la qualité du montage original
   - 9-10 : quasi parfait, 1-2 corrections mineures
   - 7-8 : bon, quelques ajustements
   - 5-6 : correct mais problèmes notables
   - 3-4 : insuffisant, beaucoup de corrections
   - 1-2 : à refaire

SORTIE JSON :
{
  "score": <int 1-10>,
  "score_rationale": "<1 phrase justifiant le score>",
  "directives": [
    {
      "timecode": "00:00-00:04",
      "action": "VIRER|CHANGER|ROTOSCOPIE|RACCOURCIR|CHANGER_TS|AJOUTER_TS",
      "current_description": "...",
      "instruction": "...",
      "ts_text": "texte du TS si applicable ou null"
    }
  ],
  "major_issues": ["<problème majeur 1>", "<problème majeur 2>"]
}`;

async function a5QC(anthropic, supabase, runId, { hookDirectives, brollDirectives, videoMap, skillSection }) {
  const content = `RÈGLES DE FORMAT DES DIRECTIVES :
${skillSection}

DIRECTIVES HOOK (de l'auditeur hook) :
${JSON.stringify(hookDirectives, null, 1)}

DIRECTIVES B-ROLL (de l'auditeur B-roll) :
${JSON.stringify(brollDirectives, null, 1)}

CARTE DE LA VIDÉO :
${JSON.stringify(videoMap, null, 1)}

Valide, nettoie, déduplique et ordonne ces directives. Attribue un score /10.`;

  return await execAgent(anthropic, supabase, {
    runId,
    name: 'a5_qc',
    systemPrompt: A5_SYSTEM,
    content,
    maxTokens: 4000,
    model: MODELS.ANALYSIS,
    temperature: 0.1,
    expectedShape: '{ "score": 5, "score_rationale": "...", "directives": [...], "major_issues": [...] }',
  });
}

// ── A6: FORMATTER ─────────────────────────────────────────────────────────
// Produit le markdown final (format Obsidian).

const A6_SYSTEM = `Tu es un formateur de directives de montage vidéo. Tu reçois des directives validées au format JSON et tu produis un markdown épuré, lisible, sans aucun bruit visuel. Le doc final est lu par un monteur sur Obsidian — il veut voir l'action et rien d'autre.

INTERDICTIONS ABSOLUES (ne JAMAIS produire ces éléments) :
- Pas de frontmatter YAML
- Pas de titre H1
- Pas de ligne de métadonnées (durée, ICP, score, client…)
- Pas de header de section ("## Directives de montage", etc.)
- Pas de footer "## See Also", pas de wikilinks, pas de séparateurs ---
- Pas de préfixe "**Action :**" devant les directives
- AUCUNE justification entre parenthèses (le pourquoi ne sort pas dans le doc final, même si c'est dans la directive d'entrée — tu dois la supprimer)
- AUCUN mot-clé stock Pexels/Artgrid (à supprimer même s'ils figurent dans la directive d'entrée)

FORMAT D'UNE DIRECTIVE :

\`\`\`
### TIMECODE | ACTION

Texte de l'action en clair, sans préfixe.
Bold (**…**) sur les mots-clés importants (DERRIÈRE, VIRER, RACCOURCIR…) quand pertinent.

> Description longue de B-roll en blockquote (UNIQUEMENT si > 1 ligne)

Durée : Xs (statique|mouvement)
\`\`\`

RÈGLES DE FORMATAGE :
- Si plusieurs actions sur le même timecode, combine-les avec "+" dans le titre : "CHANGER + ROTOSCOPIE"
- Pour un TS (CHANGER_TS, AJOUTER_TS) : mets uniquement le bloc de code TS sous le titre, sans phrase introductive
- Plans multiples : liste numérotée
- Une ligne vide entre paragraphes d'une même directive
- DEUX lignes vides entre deux directives (aération)
- Ordre chronologique strict
- Garder toutes les directives reçues — ne jamais en retirer ni en fusionner

EXEMPLE DE SORTIE ATTENDUE :

### 00:00–00:02.5 | CHANGER_TS

\`\`\`
Bureau en CAVE :
ILS DISAIENT IMPOSSIBLE
\`\`\`


### 00:01–00:02.5 | ROTOSCOPIE

Passer le B-roll du bureau aménagé **DERRIÈRE** le speaker en rotoscopie.


### 00:09–00:10 | CHANGER + ROTOSCOPIE

Remplacer le rendu 3D / image stylisée d'un bureau gaming sombre (LED, chaise gaming) par

> **bureau professionnel aménagé en sous-sol, open space épuré en basement, éclairage indirect soigné, pas de chaise gaming, pas de LED colorées**.

Durée : 1s (mouvement) — en rotoscopie.


### 00:14–00:16.5 | RACCOURCIR

Découper en 2 plans :

1. **Plan 1 (1s)** = gros plan mains de l'ouvrier **posant les briques** autour du tuyau (mouvement)
2. **Plan 2 (1s)** = gros plan sur le tuyau béton **terminé** (statique)

SI LE TABLEAU DE DIRECTIVES EST VIDE (aucune correction) :
Retourner exactement ce texte et RIEN d'autre :

Pas de retour

Retourne UNIQUEMENT les directives formatées. Pas d'introduction, pas de conclusion, pas de commentaire.`;

async function a6Formatter(anthropic, supabase, runId, { qcOutput, videoMap, metadata }) {
  const content = `DIRECTIVES VALIDÉES :
${JSON.stringify(qcOutput.directives, null, 1)}

SCORE : ${qcOutput.score}/10
JUSTIFICATION : ${qcOutput.score_rationale}
PROBLÈMES MAJEURS : ${JSON.stringify(qcOutput.major_issues)}

CARTE VIDÉO :
Durée : ${videoMap.duration_s}s
ICP : ${videoMap.icp}

METADATA :
Client : ${metadata.clientName}
Client slug : ${metadata.clientSlug}
Vidéo : ${metadata.videoName}
Version : ${metadata.version}
Take : ${metadata.take}
Date : ${new Date().toISOString().split('T')[0]}

Produis le document markdown final.`;

  return await execAgent(anthropic, supabase, {
    runId,
    name: 'a6_formatter',
    systemPrompt: A6_SYSTEM,
    content,
    maxTokens: 5000,
    model: MODELS.FORMAT,
    temperature: 0.1,
  });
}

module.exports = { a1FrameDescriber, a2Cartographer, a3HookAuditor, a4BrollAuditor, a5QC, a6Formatter };
