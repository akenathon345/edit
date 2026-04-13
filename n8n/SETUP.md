# Setup n8n — VE Edit Notion Integration

> Réplique exacte du pattern CUT (`277ec2fc-2a0c-4f93-94bb-3ea237422cc6`), adaptée pour le VE Edit.
> 2 workflows n8n : Notion → VE Edit API → Notion.

---

## Architecture

```
NOTION (bouton)
  │
  ▼
┌──────────────────────────────────────────────────────┐
│ Workflow 1 — Envoi vers VE Edit                      │
│ webhook /e7c3a8f2-9d4b-4e1c-8a6f-2b5d9c0a3e7f        │
│                                                      │
│ Webhook → Edit Fields1 → Get accounts frame.io v4    │
│   → Get asset frame.io v4 → Get client page (Notion) │
│   → Build client_slug → POST /ve-edit                │
└──────────────────────────────────────────────────────┘
  │
  │ POST { video_url, client_slug, title, notion-content-id, callback_url }
  ▼
┌──────────────────────────────────────────────────────┐
│ VE Edit API (server.js)                              │
│ → /ve-edit                                           │
│ → 202 immediate, then runs 6-agent pipeline (~2 min) │
│ → POST callback                                      │
└──────────────────────────────────────────────────────┘
  │
  │ POST { success, notion-content-id, title, score, markdown, ... }
  ▼
┌──────────────────────────────────────────────────────┐
│ Workflow 2 — Gestion retour de VE Edit               │
│ webhook /f8d4b9a3-0e5c-4f2d-9b7a-3c6e0d1b4f8a        │
│                                                      │
│ Webhook → Edit Fields → Get database page → If       │
│   → Code in JS (chunk 2000c + PATCH "retouredit")    │
└──────────────────────────────────────────────────────┘
  │
  ▼
NOTION (propriété "retouredit" = markdown VE Edit)
```

---

## Différences vs CUT (Flow)

| Étape CUT | Présent EDIT ? | Pourquoi |
|---|---|---|
| Webhook | ✅ identique | nouveau UUID |
| Edit Fields1 (extract id_asset, multihook) | ✅ adapté | propriété `MONTÉE` au lieu de `CUTÉE` + extract `client_page_id` |
| Get accounts frame.io v4 | ✅ identique | mêmes credentials |
| Get asset frame.io v4 | ✅ identique | mêmes credentials |
| Download file frame.io | ❌ supprimé | VE Edit télécharge lui-même via `video_url` |
| Change filename | ❌ supprimé | inutile |
| CloudConvert MP4→MP3 | ❌ supprimé | VE Edit extrait audio via Python/ffmpeg |
| Extract from File | ❌ supprimé | inutile |
| Make.com transcription | ❌ supprimé | VE Edit transcrit via faster-whisper en interne |
| Response to JSON | ❌ supprimé | inutile |
| HTTP Request final | ✅ adapté | URL = `/ve-edit` au lieu de `flat-analysis` |
| **Nouveau** Get client page | ✅ ajouté | récupère le nom client depuis la relation `CLIENTS` |
| **Nouveau** Build client_slug | ✅ ajouté | slugifie le nom client pour l'API |

→ **Workflow 1 EDIT = 7 nœuds** vs **CUT = 11 nœuds**.

---

## Étape 1 — Importer les workflows

1. n8n → New workflow → Import from file → `1-envoi-vers-ve-edit.json`
2. n8n → New workflow → Import from file → `2-retour-vers-notion.json`

Les credentials sont déjà référencés par ID — si tu as bien le CUT en place dans la même instance n8n, ils seront auto-mappés :
- `Frame.io v4 jesuisunsupermonteur` (OAuth2)
- `Frame.io clement ssb` (Bearer)
- `n8n accessKey` (Header)
- `PRSNL 2026` (Notion API)

---

## Étape 2 — Configurer la propriété Notion `retouredit`

Dans la DB Notion qui contient les vidéos, créer (si elle n'existe pas) :

| Propriété | Type | Description |
|---|---|---|
| `retouredit` | Text (rich_text) | Markdown généré par VE Edit |

**Workflow 2 écrit uniquement dans `retouredit`.** Si tu veux aussi un score/coût visible, ajouter ces propriétés dans la DB et adapter le code JS du workflow 2 (j'ai laissé la base, à étendre si besoin).

---

## Étape 3 — Configurer le bouton Notion

Créer un bouton (ou une automation) dans la DB qui POST vers le workflow 1 :

```
URL : https://automation.prsnl.fr/webhook/e7c3a8f2-9d4b-4e1c-8a6f-2b5d9c0a3e7f
Méthode : POST
Body : (Notion l'envoie automatiquement avec data.id, data.properties, etc.)
```

---

## Étape 4 — Variable d'environnement n8n `VE_EDIT_API_URL`

Le workflow 1 lit `$env.VE_EDIT_API_URL` pour savoir où POSTer. Régler dans n8n :

```bash
# Settings → Variables (n8n) → ajouter :
VE_EDIT_API_URL = https://votre-api.railway.app
# OU pendant les tests :
VE_EDIT_API_URL = https://drink-foreign-timer-elsewhere.trycloudflare.com
```

Si la variable n'est pas définie, le workflow tombe sur `http://localhost:3002` (qui ne marchera pas depuis n8n).

---

## Étape 5 — Déployer le VE Edit API

### Option A — Cloudflare Tunnel (test rapide, ton mac doit être allumé)

```bash
# Installer cloudflared (déjà installé dans ~/bin)
~/bin/cloudflared tunnel --url http://localhost:3002
```

→ donne une URL `https://xxx.trycloudflare.com` immédiate. Mettre cette URL dans `VE_EDIT_API_URL` dans n8n.

⚠️ Si ton mac dort ou tu coupes le terminal → tunnel down → workflow plante. Pour un usage prolongé, passer à Railway.

### Option B — Railway (production)

Le projet contient déjà `Dockerfile` + `railway.toml`. Steps :

1. Push le projet sur GitHub (repo privé recommandé) — `ve-edit-api/`
2. https://railway.app → New project → Deploy from GitHub repo
3. Railway détecte automatiquement le `Dockerfile`
4. Dans **Variables**, ajouter :
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   SUPABASE_URL=https://....supabase.co
   SUPABASE_KEY=eyJh...
   ```
5. Railway génère automatiquement une URL `https://ve-edit-api-production.up.railway.app`
6. Mettre cette URL dans `VE_EDIT_API_URL` côté n8n

Le `Dockerfile` installe Node 20 + Python 3 + ffmpeg + faster-whisper (modèle `tiny` pré-téléchargé pour démarrer vite). Coût estimé Railway : ~$5-10/mois.

### Option C — Render / Fly.io / DigitalOcean App Platform

Le `Dockerfile` est compatible avec n'importe quel hébergeur Docker. Même process que Railway.

---

## Étape 6 — Tester end-to-end

### Test 1 — VE Edit API directement (sans n8n)

```bash
curl -X POST https://votre-api/ve-edit \
  -H "Content-Type: application/json" \
  -d '{
    "video_url": "https://download.samplelib.com/mp4/sample-5s.mp4",
    "client_slug": "test-smoke",
    "version": "VM1",
    "take": "T1",
    "title": "Smoke test",
    "notion-content-id": "test-page-id-123",
    "callback_url": "https://webhook.site/your-bin"
  }'
```

→ Doit répondre immédiatement :
```json
{
  "run_id": "uuid",
  "status": "processing",
  "notion-content-id": "test-page-id-123",
  "title": "Smoke test"
}
```

→ ~60-120s plus tard, `webhook.site` reçoit :
```json
{
  "success": true,
  "run_id": "uuid",
  "notion-content-id": "test-page-id-123",
  "title": "Smoke test",
  "score": 6,
  "directives": [...],
  "markdown": "# VE Edit — ...",
  "metadata": {...}
}
```

### Test 2 — Workflow 1 n8n (simuler un trigger Notion)

```bash
curl -X POST https://automation.prsnl.fr/webhook/e7c3a8f2-9d4b-4e1c-8a6f-2b5d9c0a3e7f \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "id": "PAGE-ID-NOTION",
      "properties": {
        "Name": { "title": [{ "plain_text": "Vidéo test" }] },
        "MONTÉE": {
          "files": [{
            "name": "https://next.frame.io/project/xxx/view/UUID-de-l-asset"
          }]
        },
        "CLIENTS": {
          "relation": [{ "id": "PAGE-CLIENT-NOTION-ID" }]
        }
      }
    }
  }'
```

### Test 3 — Bouton Notion en condition réelle

Cliquer sur le bouton dans la DB Notion → vérifier dans n8n que le workflow 1 s'exécute → vérifier ~2 min plus tard que la propriété `retouredit` de la page contient le markdown.

---

## Payload de référence

### Ce que workflow 1 envoie au VE Edit API

```json
{
  "video_url": "https://cdn.frame.io/.../efficient/video.mp4",
  "client_slug": "gary-abitbol",
  "version": "VM1",
  "take": "T1",
  "title": "Vidéo n°2 Yann Tyburn",
  "notion-content-id": "25bdcb38-66b4-809a-82eb-ce6960cf3a19",
  "callback_url": "https://automation.prsnl.fr/webhook/f8d4b9a3-0e5c-4f2d-9b7a-3c6e0d1b4f8a"
}
```

### Ce que VE Edit renvoie au workflow 2

```json
{
  "success": true,
  "run_id": "49100bc8-1a66-4b94-8b1c-0acafa01cff7",
  "notion-content-id": "25bdcb38-66b4-809a-82eb-ce6960cf3a19",
  "title": "Vidéo n°2 Yann Tyburn",
  "score": 6,
  "directives": [...],
  "markdown": "# VE Edit — ...",
  "metadata": {
    "duration_ms": 150931,
    "tokens_total": 25000,
    "cost_estimate": 0.44
  }
}
```

---

## UUIDs des webhooks (à mémoriser)

| Workflow | Webhook UUID |
|---|---|
| 1 — Envoi vers VE Edit | `e7c3a8f2-9d4b-4e1c-8a6f-2b5d9c0a3e7f` |
| 2 — Retour de VE Edit | `f8d4b9a3-0e5c-4f2d-9b7a-3c6e0d1b4f8a` |

URLs complètes :
```
https://automation.prsnl.fr/webhook/e7c3a8f2-9d4b-4e1c-8a6f-2b5d9c0a3e7f
https://automation.prsnl.fr/webhook/f8d4b9a3-0e5c-4f2d-9b7a-3c6e0d1b4f8a
```

---

## Troubleshooting

| Problème | Cause probable | Solution |
|---|---|---|
| Webhook Notion ne trigger pas | Bouton mal configuré | Vérifier l'URL et que la DB envoie bien `data.properties` |
| Frame.io 401 | Token OAuth2 expiré | Re-connecter le credential dans n8n |
| Frame.io 404 | id_asset_frame mal extrait | Vérifier que la propriété s'appelle bien `MONTÉE` et contient un fichier |
| `client_slug` = "unknown" | Le nom du client n'est pas dans `Name` | Adapter le code dans `Build client_slug` pour pointer vers la bonne propriété |
| VE Edit timeout | Vidéo trop longue (>3min) ou serveur down | Vérifier que VE_EDIT_API_URL pointe vers une URL accessible et up |
| Callback jamais reçu | Mauvaise URL callback ou serveur down après envoi | Vérifier les logs VE Edit, vérifier que le workflow 2 est ACTIVE dans n8n |
| Notion update échoue | Propriété `retouredit` n'existe pas | La créer (type Text/rich_text) dans la DB |
| Pipeline génère un score ridicule | Pas de transcription / mauvaise vidéo | Vérifier les logs `[A1]`, `[A2]`, `[QC]` côté serveur |
