-- VE Edit API — Supabase Tables
-- Run this in the Supabase SQL Editor

-- Client guidelines (one row per client)
CREATE TABLE IF NOT EXISTS client_guidelines (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_slug TEXT UNIQUE NOT NULL,
  client_name TEXT NOT NULL,
  icp TEXT,
  guidelines_content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Pipeline run tracking
CREATE TABLE IF NOT EXISTS ve_edit_runs (
  id UUID PRIMARY KEY,
  client_slug TEXT NOT NULL,
  video_name TEXT,
  version TEXT,
  take TEXT,
  score INTEGER,
  directives_count INTEGER,
  tokens_total INTEGER,
  cost_estimate NUMERIC,
  duration_ms INTEGER,
  markdown_output TEXT,
  status TEXT DEFAULT 'running',
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-agent execution logs
CREATE TABLE IF NOT EXISTS ve_edit_agent_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id UUID REFERENCES ve_edit_runs(id),
  agent_name TEXT NOT NULL,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  status TEXT,
  output_raw TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast run lookup
CREATE INDEX IF NOT EXISTS idx_ve_edit_runs_status ON ve_edit_runs(status);
CREATE INDEX IF NOT EXISTS idx_ve_edit_agent_logs_run_id ON ve_edit_agent_logs(run_id);

-- Example: insert Gary Abitbol guidelines
-- INSERT INTO client_guidelines (client_slug, client_name, icp, guidelines_content) VALUES (
--   'gary-abitbol',
--   'Gary Abitbol (EZAK)',
--   'Électriciens/installateurs 25-50 ans, propriétaires 30-55 ans intéressés par la domotique accessible.',
--   '## Règles spécifiques
-- - Pas de maison ultra-luxe — le client doit se projeter chez lui (pavillon contemporain, pas villa architecte)
-- - Pas de voiture de luxe, pas de flexing
-- - Le mot-clé est "accessible" — chaque plan doit respirer "je peux faire ça chez moi"
-- - Montrer des solutions domotiques simples et modernes, pas des showrooms
-- - Ne pas écrire les noms de marques partenaires (Symfonyx, etc.) — pas connues du public'
-- );
