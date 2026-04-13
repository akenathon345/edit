# Replay A6 — Itération rapide sur le formateur

> Outil CLI pour re-jouer **uniquement** l'agent A6 (formateur Markdown) sur un run existant, sans re-exécuter le pipeline complet (A1 vision = cher et lent).

**Cas d'usage principal :** itérer sur le prompt `A6_SYSTEM` (`lib/agents.js`) jusqu'à obtenir le format de sortie souhaité, en testant sur de vrais runs déjà exécutés.

---

## Pourquoi cet outil

Le pipeline complet (`runPipeline`) coûte ~$0.40-1.00 et prend 1-3 min par vidéo, dont l'essentiel est l'A1 (vision Sonnet sur toutes les frames). Quand on veut juste tester un changement de format de sortie, c'est du gaspillage.

Comme A2 (`videoMap`) et A5 (`qcOutput`) sont déjà persistés dans `ve_edit_agent_logs.output_raw`, on peut les recharger depuis Supabase et n'appeler que A6.

**Coût d'un replay :** ~$0.011 (Haiku) — ~19s

---

## Comment ça marche

```
Supabase
  ├── ve_edit_runs           ← métadonnées run (client, video, version, take, markdown_output)
  └── ve_edit_agent_logs     ← output_raw de chaque agent (tronqué à 50K chars)
        ├── a2_cartographer  → videoMap JSON
        └── a5_qc            → qcOutput JSON (directives validées + score)

scripts/replay-a6.js
  1. Résout le runId (arg explicite, ou "latest" éventuellement filtré par client)
  2. Charge le run + tous ses agent_logs
  3. Garde le dernier log "success" par agent
  4. Parse a2.output_raw → videoMap, a5.output_raw → qcOutput
  5. Appelle a6Formatter(qcOutput, videoMap, metadata)
  6. Print le markdown sur stdout (ou un diff vs original avec --diff)
```

Le replay **ne touche pas** Supabase (passe `null` comme client supabase à `a6Formatter`) — pas de log polluant pour les itérations.

---

## Usage

```bash
# Replay sur un runId explicite
node scripts/replay-a6.js <runId>

# Replay sur le run le plus récent (tous clients confondus)
node scripts/replay-a6.js latest

# Replay sur le run le plus récent d'un client donné
node scripts/replay-a6.js latest gary-abitbol

# Diff vs le markdown_output original stocké en base
node scripts/replay-a6.js <runId> --diff
node scripts/replay-a6.js latest gary-abitbol --diff
```

**Sortie :**
- `stdout` → markdown final (ou diff)
- `stderr` → logs de progression (`[replay-a6] ...`)

Pour sauvegarder dans un fichier :

```bash
node scripts/replay-a6.js latest > /tmp/replay.md
```

---

## Trouver un runId

Option 1 — `latest` :

```bash
node scripts/replay-a6.js latest
node scripts/replay-a6.js latest halonn-villalba
```

Option 2 — Query SQL Supabase :

```sql
SELECT id, client_slug, video_name, score, created_at
FROM ve_edit_runs
WHERE status = 'completed'
ORDER BY created_at DESC
LIMIT 10;
```

---

## Workflow d'itération sur A6_SYSTEM

1. Identifier un run de référence (idéalement avec un output bloated qui illustre le problème)
2. `node scripts/replay-a6.js <runId> > /tmp/baseline.md` — capturer la sortie actuelle
3. Éditer `lib/agents.js` → `A6_SYSTEM` (lignes ~425-443)
4. `node scripts/replay-a6.js <runId> > /tmp/after.md`
5. `diff /tmp/baseline.md /tmp/after.md` ou utiliser le flag `--diff` (compare au markdown_output original en base)
6. Itérer jusqu'à validation
7. Re-tester sur 2-3 runs d'autres clients pour vérifier la généralisation
8. Une fois validé → un vrai run via `POST /ve-edit` pour confirmer end-to-end

---

## Pré-requis

Variables d'environnement (`.env` à la racine du projet) :

```
SUPABASE_URL=...
SUPABASE_KEY=...
ANTHROPIC_API_KEY=...
```

---

## Limites connues

- **`output_raw` tronqué à 50000 caractères** dans `ve_edit_agent_logs` (cf. `lib/qc.js`). Pour A2/A5 ça suffit largement (JSON de quelques Ko), mais à garder en tête si on étend l'outil à A1 (qui produit beaucoup plus).
- **Pas de re-fetch des `client_guidelines`** — le replay passe `clientName = clientSlug` dans la metadata. A6 ne se sert pas du nom client pour grand-chose, mais si un jour le formateur devient sensible au branding il faudra ajouter un `loadClientGuidelines()`.
- **Replay scope = A6 uniquement.** Pour itérer sur A3/A4/A5, créer un script analogue (`replay-a5.js`, etc.) en ré-utilisant le même pattern (`fetchRun` + appel direct de l'agent).

---

## Test de validation initial

Exécuté le 2026-04-09 sur le run `e01b0860-a7ff-4aa6-acbe-cb5d22dc8a29` (halonn-villalba / `dl_1775729885715`, score 4) :

- Reproduit à l'identique la sortie bloated baseline (16 directives)
- Durée : 18.9s
- Tokens : 3192 in / 2084 out
- Coût : ~$0.011

Confirme que le pipeline de replay est isofunctional avec un appel A6 en production.
