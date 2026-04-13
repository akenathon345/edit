# VE Edit API — Documentation technique

> Service d'analyse et validation de montage vidéo (Reels/TikTok/Shorts) par pipeline multi-agents Claude.
> Le service reçoit une vidéo, l'analyse frame par frame, et retourne des directives de montage actionnables.

**Base URL :** `http://localhost:3002` (dev) — à remplacer par l'URL de production.

---

## Table des matières

1. [Quickstart](#1-quickstart)
2. [Endpoints](#2-endpoints)
3. [Modes d'intégration](#3-modes-dintégration)
4. [Payloads — Requêtes](#4-payloads--requêtes)
5. [Payloads — Réponses](#5-payloads--réponses)
6. [Gestion des erreurs](#6-gestion-des-erreurs)
7. [Guidelines client (Supabase)](#7-guidelines-client-supabase)
8. [Architecture pipeline](#8-architecture-pipeline)
9. [Déploiement](#9-déploiement)
10. [Exemples d'intégration](#10-exemples-dintégration)

---

## 1. Quickstart

```bash
# Health check
curl http://localhost:3002/health

# Envoyer une vidéo (upload fichier)
curl -X POST http://localhost:3002/ve-edit \
  -F "video=@/path/to/video.mp4" \
  -F "client_slug=gary-abitbol" \
  -F "version=VM3" \
  -F "take=T1"

# Envoyer un chemin local (si le serveur a accès au filesystem)
curl -X POST http://localhost:3002/ve-edit \
  -H "Content-Type: application/json" \
  -d '{
    "video_path": "/path/to/video.mp4",
    "client_slug": "gary-abitbol",
    "version": "VM3",
    "take": "T1"
  }'
```

---

## 2. Endpoints

### `GET /health`

Health check simple.

**Response :**
```json
{ "status": "ok", "service": "ve-edit-api" }
```

---

### `POST /ve-edit`

Endpoint principal. Accepte une vidéo et retourne les directives de montage.

**Content-Type :** `application/json` OU `multipart/form-data` (upload fichier)

---

### `GET /ve-edit/:run_id`

Polling du statut d'un run (mode async). Retourne le résultat si terminé.

**Response (en cours) :**
```json
{ "run_id": "uuid", "status": "running" }
```

**Response (terminé) :**
```json
{
  "run_id": "uuid",
  "status": "completed",
  "result": {
    "score": 6,
    "directives_count": 7,
    "markdown": "..."
  }
}
```

---

## 3. Modes d'intégration

Le service supporte **3 modes** d'intégration. Choisissez selon votre besoin.

### Mode A — Synchrone (simple)

> Le client attend la réponse. Timeout recommandé : **5 minutes**.

```
Client  ──POST /ve-edit──►  VE Edit API
        ◄── 200 + résultat ──
        (attente 1-3 min)
```

**Quand l'utiliser :** tests, intégrations simples, scripts manuels.

```bash
curl -X POST http://localhost:3002/ve-edit \
  -H "Content-Type: application/json" \
  -d '{"video_path": "/path/to/video.mp4", "client_slug": "gary-abitbol"}' \
  --max-time 300
```

---

### Mode B — Async avec callback (recommandé pour Notion/Make/n8n)

> Le client envoie la requête avec une `callback_url`. Le service répond immédiatement `202`, puis POST le résultat sur la callback_url quand c'est terminé.

```
Client  ──POST /ve-edit + callback_url──►  VE Edit API
        ◄── 202 { run_id, status: "processing" } ──

        ... 1-3 min plus tard ...

VE Edit API  ──POST callback_url──►  Client webhook
             { success: true, run_id, score, directives, markdown, metadata }
```

**Quand l'utiliser :** automatisations Notion/Make/n8n, intégrations production.

```bash
curl -X POST http://localhost:3002/ve-edit \
  -H "Content-Type: application/json" \
  -d '{
    "video_path": "/path/to/video.mp4",
    "client_slug": "manon-allano",
    "version": "VM3",
    "take": "T1",
    "callback_url": "https://hooks.make.com/xxx"
  }'
```

**Ce que votre webhook recevra :**
```json
{
  "success": true,
  "run_id": "49100bc8-...",
  "score": 4,
  "score_rationale": "Nombreux problèmes...",
  "directives": [ ... ],
  "major_issues": [ ... ],
  "markdown": "# VE Edit — ...",
  "metadata": { ... }
}
```

---

### Mode C — Async avec polling

> Le client envoie la requête avec `callback_url`, récupère le `run_id`, puis poll `GET /ve-edit/:run_id` jusqu'à completion.

```
Client  ──POST /ve-edit + callback_url──►  VE Edit API
        ◄── 202 { run_id } ──

        ──GET /ve-edit/:run_id──►  { status: "running" }
        ──GET /ve-edit/:run_id──►  { status: "running" }
        ──GET /ve-edit/:run_id──►  { status: "completed", result: {...} }
```

**Quand l'utiliser :** si votre système ne peut pas recevoir de webhooks.

---

## 4. Payloads — Requêtes

### `POST /ve-edit` — JSON body

| Champ | Type | Requis | Description |
|---|---|---|---|
| `video_path` | `string` | **oui*** | Chemin absolu vers le fichier vidéo sur le serveur |
| `video_url` | `string` | **oui*** | URL publique de la vidéo à télécharger (ex: Frame.io download URL) |
| `client_slug` | `string` | non | Identifiant client pour charger les guidelines (ex: `gary-abitbol`, `manon-allano`) |
| `version` | `string` | non | Version du montage (défaut: `V1`). Ex: `VM3`, `VM4` |
| `take` | `string` | non | Numéro de take (défaut: `T1`). Ex: `T1`, `T2` |
| `callback_url` | `string` | non | URL webhook pour le mode async. Si présent → réponse 202 immédiate |
| `notion_content_id` | `string` | non | ID de la page Notion — renvoyé tel quel dans la réponse/callback (pass-through) |
| `title` | `string` | non | Titre de la vidéo — renvoyé tel quel dans la réponse/callback (pass-through) |
| `pass_through` | `object` | non | Objet libre renvoyé tel quel dans la réponse/callback |
| `verbose` | `boolean` | non | Active les logs détaillés par agent (défaut: `false`) |

*\* Un des trois est requis : `video_path`, `video_url`, ou upload fichier via multipart.*

### `POST /ve-edit` — Multipart (upload fichier)

| Champ | Type | Requis | Description |
|---|---|---|---|
| `video` | `file` | **oui*** | Le fichier vidéo (.mp4, .mov, .webm) |
| `client_slug` | `string` | non | Identifiant client |
| `version` | `string` | non | Version du montage |
| `take` | `string` | non | Numéro de take |
| `callback_url` | `string` | non | URL webhook async |

*\* Le fichier est requis sauf si `video_path` est fourni dans le body.*

**Exemple upload fichier :**
```bash
curl -X POST http://localhost:3002/ve-edit \
  -F "video=@./ma_video.mp4" \
  -F "client_slug=manon-allano" \
  -F "version=VM3" \
  -F "take=T1" \
  -F "callback_url=https://hooks.make.com/xxx"
```

---

## 5. Payloads — Réponses

### Réponse succès (200)

```json
{
  "success": true,
  "run_id": "49100bc8-1a66-4b94-8b1c-0acafa01cff7",

  "score": 4,
  "score_rationale": "Nombreux problèmes cumulés : TS descriptif, logo concurrent visible...",

  "directives": [
    {
      "timecode": "00:00-00:05.5",
      "action": "CHANGER_TS",
      "current_description": "TS 'La bonne utilisation du masque LED' — descriptif",
      "instruction": "Remplacer le TS. Maintenir EN CONTINU de 00:00 à 00:05.5.",
      "ts_text": "Masque LED :\nTU L'UTILISES MAL"
    },
    {
      "timecode": "00:01-00:03.8",
      "action": "RACCOURCIR",
      "current_description": "PiP TikTok scroll avec logo GOKOCO visible",
      "instruction": "Raccourcir à 1.5s max. Flouter tous les logos.",
      "ts_text": null
    }
  ],

  "major_issues": [
    "Speaker absent trop longtemps",
    "Logo concurrent GOKOCO visible sans floutage",
    "ICP non respectée (jeune femme ~18 ans au lieu de cible 30-55)"
  ],

  "markdown": "# VE Edit — LaBonneUtilisationDesMasquesLED — VM3 — Manon Allano — T1\n\n...",

  "metadata": {
    "duration_ms": 150931,
    "tokens_total": 170684,
    "tokens_in": 154255,
    "tokens_out": 16429,
    "cost_estimate": 1.24,
    "video_duration_s": 29.3,
    "frames_count": 61,
    "client": "Manon Allano (EstheClinic)",
    "agents": {
      "a1_frame_describer": { "tokensIn": 99131, "tokensOut": 10181, "duration_ms": 51479 },
      "a2_cartographer":    { "tokensIn": 11474, "tokensOut": 1260,  "duration_ms": 22328 },
      "a3_hook_auditor":    { "tokensIn": 13023, "tokensOut": 760,   "duration_ms": 17328 },
      "a4_broll_auditor":   { "tokensIn": 21581, "tokensOut": 1483,  "duration_ms": 33875 },
      "a5_qc":              { "tokensIn": 6964,  "tokensOut": 1601,  "duration_ms": 25397 },
      "a6_formatter":       { "tokensIn": 2082,  "tokensOut": 1144,  "duration_ms": 11047 }
    }
  }
}
```

### Champs de la réponse

| Champ | Type | Description |
|---|---|---|
| `success` | `boolean` | `true` si le pipeline a tourné sans erreur |
| `run_id` | `string` (UUID) | Identifiant unique du run — utilisable pour le polling |
| `score` | `integer` (1-10) | Score qualité du montage original |
| `score_rationale` | `string` | Justification du score en 1 phrase |
| `directives` | `array` | Liste des corrections à appliquer (voir ci-dessous) |
| `major_issues` | `array<string>` | Problèmes majeurs identifiés |
| `markdown` | `string` | Document Obsidian complet, prêt à copier |
| `metadata` | `object` | Métriques de performance du pipeline |

### Structure d'une directive

| Champ | Type | Description |
|---|---|---|
| `timecode` | `string` | Plage temporelle (ex: `"00:05.5-00:06.5"`) |
| `action` | `string` | Action à effectuer (voir tableau ci-dessous) |
| `current_description` | `string` | Ce qui est actuellement visible à ce timecode |
| `instruction` | `string` | Instruction concrète pour le monteur |
| `ts_text` | `string\|null` | Texte du nouveau Titre Simple (si applicable) |

### Actions possibles

| Action | Description |
|---|---|
| `VIRER` | Supprimer le plan, revenir sur le speaker |
| `CHANGER` | Remplacer par un plan précis (QUI + OÙ + QUOI + durée) |
| `RACCOURCIR` | Réduire la durée du plan (durée cible indiquée) |
| `ROTOSCOPIE` | Speaker détouré au premier plan, plan actuel en arrière-plan |
| `CHANGER_TS` | Remplacer le Titre Simple (texte exact fourni dans `ts_text`) |
| `AJOUTER_TS` | Ajouter un Titre Simple manquant |

---

## 6. Gestion des erreurs

### Codes HTTP

| Code | Signification |
|---|---|
| `200` | Succès (mode sync) |
| `202` | Accepté, traitement en cours (mode async) |
| `400` | Erreur de validation (body invalide, vidéo introuvable) |
| `404` | Run introuvable (GET /ve-edit/:run_id) |
| `500` | Erreur serveur / pipeline |

### Format d'erreur

```json
{
  "success": false,
  "error": "video_path introuvable: /tmp/fake.mp4"
}
```

Avec run_id (si le pipeline a démarré) :
```json
{
  "success": false,
  "run_id": "c5b66b65-...",
  "error": "extract.py failed (code 1): ..."
}
```

### Erreurs courantes

| Erreur | Cause | Solution |
|---|---|---|
| `video_path ou fichier video requis` | Pas de vidéo fournie | Envoyer `video_path` ou upload fichier |
| `video_path introuvable: ...` | Le fichier n'existe pas sur le serveur | Vérifier le chemin ou uploader le fichier |
| `JSON invalide dans le body` | Body n'est pas du JSON valide | Vérifier le Content-Type et le format |
| `ANTHROPIC_API_KEY manquante` | Clé API non configurée | Vérifier le `.env` |
| `Bundle invalide: 0 frames extraites` | Vidéo corrompue ou format non supporté | Vérifier le fichier vidéo |
| `extract.py failed (code 1)` | Python/OpenCV/Whisper erreur | Vérifier les dépendances Python |

---

## 7. Guidelines client (Supabase)

Les guidelines sont stockées dans la table `client_guidelines` sur Supabase. Elles permettent de personnaliser l'analyse par client.

### Structure de la table

| Colonne | Type | Description |
|---|---|---|
| `client_slug` | `text` (UNIQUE) | Identifiant URL-safe (ex: `gary-abitbol`) |
| `client_name` | `text` | Nom d'affichage (ex: `Gary Abitbol (EZAK)`) |
| `icp` | `text` | Description du client idéal |
| `guidelines_content` | `text` | Contenu markdown complet des guidelines |

### Ajouter un nouveau client

```sql
INSERT INTO client_guidelines (client_slug, client_name, icp, guidelines_content)
VALUES (
  'nom-client',
  'Nom Client (Marque)',
  'Description ICP...',
  '## Règles spécifiques\n- Règle 1\n- Règle 2\n...'
);
```

### Via l'API Supabase (REST)

```bash
curl -X POST "https://vnjjirxkbswzjmdcvemh.supabase.co/rest/v1/client_guidelines" \
  -H "apikey: YOUR_SUPABASE_KEY" \
  -H "Authorization: Bearer YOUR_SUPABASE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "client_slug": "nom-client",
    "client_name": "Nom Client",
    "icp": "Description ICP...",
    "guidelines_content": "## Règles spécifiques\n..."
  }'
```

### Clients configurés

| Slug | Client | Guidelines |
|---|---|---|
| `gary-abitbol` | Gary Abitbol (EZAK) | 17 478 chars — Domotique accessible |
| `manon-allano` | Manon Allano (EstheClinic) | 11 339 chars — Beauté préventive non-invasive |

### Sans client_slug

Si `client_slug` n'est pas fourni ou si le client n'existe pas en base, le pipeline tourne quand même avec les guidelines de base uniquement (règles VE Edit génériques). Les résultats seront moins précis mais fonctionnels.

---

## 8. Architecture pipeline

```
Vidéo MP4
    │
    ▼
┌─────────────────────────┐
│  Extract (Python)       │  OpenCV : 1 frame / 0.5s
│  + Whisper transcription│  Whisper base : transcription FR
│                         │  → Bundle : frames/ + index.json
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  A1 — Frame Describer   │  Sonnet 4.6 (vision)
│  Batches de 20 frames   │  Seul agent qui voit les images
│  en parallèle           │  → JSON descriptions par frame
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  A2 — Cartographer      │  Sonnet 4.6
│  Construit la carte     │  Hooks, B-roll plans, phases, ICP
│  structurée de la vidéo │  → Video Map JSON
└────────────┬────────────┘
             ▼
     ┌───────┴───────┐
     ▼               ▼
┌──────────┐  ┌──────────────┐
│ A3 Hook  │  │ A4 B-roll    │  Opus 4.6 (les deux)
│ Auditor  │  │ Auditor      │  Exécution en PARALLÈLE
│          │  │              │
│ Analyse  │  │ Analyse tous │
│ le hook  │  │ les plans de │
│ (0-6s)   │  │ coupe        │
└────┬─────┘  └──────┬───────┘
     └───────┬───────┘
             ▼
┌─────────────────────────┐
│  A5 — QC Agent          │  Sonnet 4.6
│  Valide, déduplique,    │  Score /10
│  ordonne les directives │  → Directives finales
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│  A6 — Formatter         │  Haiku 4.5
│  Génère le markdown     │  → Document Obsidian
│  Obsidian final         │
└─────────────────────────┘
```

### Modèles utilisés

| Agent | Modèle | Rôle |
|---|---|---|
| A1 Frame Describer | `claude-sonnet-4-6` | Vision multimodale — décrit chaque frame |
| A2 Cartographer | `claude-sonnet-4-6` | Construit la carte vidéo structurée |
| A3 Hook Auditor | `claude-opus-4-6` | Décisions créatives sur le hook |
| A4 B-roll Auditor | `claude-opus-4-6` | Décisions créatives sur les plans de coupe |
| A5 QC Agent | `claude-sonnet-4-6` | Validation, déduplication, scoring |
| A6 Formatter | `claude-haiku-4-5` | Mise en forme markdown |

### Performances typiques

| Métrique | Valeur typique |
|---|---|
| Durée totale | 90-150 secondes |
| Coût par run | $1.00-1.50 |
| Frames analysées | 50-80 (vidéo 25-40s) |
| Directives générées | 4-8 |

### Résilience

- **Retry automatique** : 3 retries avec backoff (2s → 5s → 15s) sur erreurs 429/529/503
- **Timeout par agent** : 3 minutes max
- **Fallback JSON** : si un agent retourne du JSON mal formé, un agent QC reformate
- **Guards** : 0 frames → erreur explicite, videoMap cassée → defaults, directives nulles → array vide
- **Process** : uncaughtException et unhandledRejection capturés — le serveur ne crash jamais

---

## 9. Déploiement

### Variables d'environnement

```env
ANTHROPIC_API_KEY=sk-ant-...          # Clé API Anthropic (obligatoire)
SUPABASE_URL=https://xxx.supabase.co  # URL Supabase (optionnel)
SUPABASE_KEY=eyJ...                   # Service role key Supabase (optionnel)
PORT=3002                             # Port du serveur (défaut: 3002)
BUNDLE_TMP_DIR=/tmp/ve-edit-bundles   # Répertoire temporaire pour les bundles
```

### Dépendances système

| Outil | Version | Usage |
|---|---|---|
| Node.js | >= 18 | Serveur Express |
| Python 3 | >= 3.9 | Extraction frames + transcription |
| OpenCV (`cv2`) | pip | Extraction des frames vidéo |
| Whisper (`openai-whisper`) | pip | Transcription audio français |
| ffmpeg | binaire | Requis par Whisper pour l'extraction audio |

### Installation

```bash
# Node
cd ve-edit-api
npm install

# Python
pip install opencv-python openai-whisper

# ffmpeg (si pas installé)
# macOS: brew install ffmpeg
# Linux: apt install ffmpeg
# Ou: télécharger le binaire statique dans /tmp/ffmpeg

# Lancer
npm start
# ou
node server.js
```

### Structure des fichiers

```
ve-edit-api/
├── server.js                 # Express server — routes + error handling
├── package.json
├── .env                      # Variables d'environnement
├── lib/
│   ├── agents.js             # 6 agents avec system prompts
│   ├── anthropic.js          # Client Anthropic singleton
│   ├── extract.js            # Extraction vidéo (spawn Python)
│   ├── guidelines.js         # Chargement guidelines base + client
│   ├── pipeline.js           # Orchestrateur principal
│   ├── qc.js                 # callClaude, retry, parseJSON, execAgent
│   ├── skill-sections.js     # Parsing du SKILL.md par section
│   └── supabase.js           # Client Supabase singleton
├── data/
│   ├── SKILL.md              # Règles VE Edit complètes
│   └── GUIDELINES-BASE.md    # Guidelines montage de base
├── scripts/
│   └── extract_cv.py         # OpenCV + Whisper extraction
├── sql/
│   └── setup.sql             # Création tables Supabase
└── docs/
    └── API.md                # Cette documentation
```

---

## 10. Exemples d'intégration

### Depuis Make.com / n8n (webhook)

```
1. HTTP Request (POST)
   URL: http://your-server:3002/ve-edit
   Content-Type: application/json
   Body:
   {
     "video_path": "/path/to/video.mp4",
     "client_slug": "gary-abitbol",
     "version": "VM3",
     "take": "T1",
     "callback_url": "https://hook.make.com/your-scenario-webhook"
   }

2. Le scénario reçoit un 202 immédiat
3. Configurez un SECOND webhook qui recevra le résultat complet
4. Dans ce webhook, utilisez:
   - {{body.success}} → boolean
   - {{body.score}} → integer (1-10)
   - {{body.directives}} → array de corrections
   - {{body.markdown}} → document complet à insérer dans Notion
   - {{body.metadata.cost_estimate}} → coût du run
```

### Depuis Notion (via Make/n8n)

```
Notion Database (trigger: new row)
    │
    ▼
Get video URL from Notion page
    │
    ▼
Download video to server temp dir
    │
    ▼
POST /ve-edit avec callback_url
    │
    ▼
Webhook reçoit le résultat
    │
    ▼
Update Notion page:
  - Score: {{body.score}}/10
  - Status: "Analysé"
  - Directives: {{body.markdown}}
  - Coût: {{body.metadata.cost_estimate}}€
```

### Depuis JavaScript/TypeScript

```javascript
// Mode sync
const response = await fetch('http://localhost:3002/ve-edit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    video_path: '/path/to/video.mp4',
    client_slug: 'manon-allano',
    version: 'VM3',
    take: 'T1',
  }),
});

const result = await response.json();
console.log(`Score: ${result.score}/10`);
console.log(`Directives: ${result.directives.length}`);
console.log(`Coût: $${result.metadata.cost_estimate}`);

// Mode async avec callback
const asyncResponse = await fetch('http://localhost:3002/ve-edit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    video_path: '/path/to/video.mp4',
    client_slug: 'manon-allano',
    callback_url: 'https://your-server.com/webhook/ve-edit',
  }),
});

const { run_id } = await asyncResponse.json();
// Le résultat arrivera sur votre webhook
```

### Depuis Python

```python
import requests

# Mode sync
response = requests.post("http://localhost:3002/ve-edit", json={
    "video_path": "/path/to/video.mp4",
    "client_slug": "gary-abitbol",
    "version": "VM4",
    "take": "T2",
}, timeout=300)

data = response.json()
print(f"Score: {data['score']}/10")
for d in data["directives"]:
    print(f"  {d['timecode']} | {d['action']} — {d['instruction']}")

# Upload fichier
with open("video.mp4", "rb") as f:
    response = requests.post("http://localhost:3002/ve-edit",
        files={"video": f},
        data={"client_slug": "manon-allano", "version": "VM3", "take": "T1"},
        timeout=300,
    )
```

### Depuis cURL — Upload fichier

```bash
curl -X POST http://localhost:3002/ve-edit \
  -F "video=@./MaSuperVideo_ClientX_VM2_T1.mp4" \
  -F "client_slug=manon-allano" \
  -F "version=VM2" \
  -F "take=T1" \
  --max-time 300
```

---

## Annexe — Tables Supabase

### `client_guidelines`

Stocke les guidelines de montage spécifiques à chaque client.

```sql
CREATE TABLE client_guidelines (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_slug TEXT UNIQUE NOT NULL,  -- ex: 'gary-abitbol'
  client_name TEXT NOT NULL,         -- ex: 'Gary Abitbol (EZAK)'
  icp TEXT,                          -- description du client idéal
  guidelines_content TEXT NOT NULL,  -- markdown complet
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### `ve_edit_runs`

Log de chaque run du pipeline.

```sql
CREATE TABLE ve_edit_runs (
  id UUID PRIMARY KEY,             -- = run_id retourné au client
  client_slug TEXT NOT NULL,
  video_name TEXT,
  version TEXT,
  take TEXT,
  score INTEGER,                   -- 1-10
  directives_count INTEGER,
  tokens_total INTEGER,
  cost_estimate NUMERIC,           -- en USD
  duration_ms INTEGER,
  markdown_output TEXT,
  status TEXT DEFAULT 'running',   -- running | completed | failed
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### `ve_edit_agent_logs`

Log détaillé par agent (pour debug/monitoring).

```sql
CREATE TABLE ve_edit_agent_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID REFERENCES ve_edit_runs(id),
  agent_name TEXT NOT NULL,        -- ex: 'a3_hook_auditor'
  model TEXT,                      -- ex: 'claude-opus-4-6'
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  status TEXT,                     -- started | success | reformatted | fallback_raw
  output_raw TEXT,                 -- réponse brute de l'agent (debug)
  created_at TIMESTAMPTZ DEFAULT now()
);
```
