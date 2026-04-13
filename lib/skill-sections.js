const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'data', 'SKILL.md');

let _skillCache = null;

function loadSkill() {
  if (!_skillCache) {
    _skillCache = fs.readFileSync(SKILL_PATH, 'utf-8');
  }
  return _skillCache;
}

/**
 * Extract a section from SKILL.md between start_marker and end_marker.
 * If end_marker is null, extracts from start_marker to end of file.
 */
function extractSection(startMarker, endMarker = null) {
  const skill = loadSkill();
  const idx = skill.indexOf(startMarker);
  if (idx === -1) return '';

  if (endMarker) {
    const end = skill.indexOf(endMarker, idx + startMarker.length);
    return end > -1 ? skill.substring(idx, end).trim() : skill.substring(idx).trim();
  }
  return skill.substring(idx).trim();
}

/**
 * Get pre-configured sections for each agent.
 * Each agent gets ONLY the rules relevant to its job.
 */
function getSectionsForAgents() {
  return {
    // A1: Frame Describer — how to read frames
    frameDescriber: extractSection('### Lire les frames', '## Étape 2'),

    // A2: Cartographer — how to build the video map
    cartographer: extractSection('## Étape 2 — Cartographier la vidéo', '## Étape 3'),

    // A3: Hook Auditor — hook visual + titre simple rules
    hookAuditor: [
      extractSection('### HOOK VISUEL (0 à 3 secondes de chaque hook)', '### TITRE SIMPLE (TS)'),
      extractSection('### TITRE SIMPLE (TS)', '### PLANS DE COUPE (B-ROLL)'),
    ].join('\n\n'),

    // A4: Broll Auditor — B-roll + forbidden + IA + expressivity + montage + familiarité + musique
    brollAuditor: [
      extractSection('### PLANS DE COUPE (B-ROLL)', '### PLANS IA'),
      extractSection('### PLANS IA — RECONNAÎTRE ET VALIDER', '### VISUELS INTERDITS'),
      extractSection('### VISUELS INTERDITS', '### CAPITALISER'),
      extractSection('### CAPITALISER SUR L\'EXPRESSIVITÉ', '### LE MONTAGE PREND PARTI'),
      extractSection('### LE MONTAGE PREND PARTI', '### FAMILIARITÉ'),
      extractSection('### FAMILIARITÉ', '### MUSIQUE'),
      extractSection('### MUSIQUE', '## Étape 4'),
    ].join('\n\n'),

    // A5: QC — directive format rules + what never to do
    qcAgent: [
      extractSection('### Principe fondamental', '### Format de sortie'),
      extractSection('### Format de sortie', '### Les 5 niveaux'),
      extractSection('### Les 5 niveaux de directive', '### Ce qu\'on ne fait JAMAIS'),
      extractSection('### Ce qu\'on ne fait JAMAIS dans les directives', '### Directives spéciales'),
      extractSection('### Directives spéciales', '### Structure du livrable'),
      extractSection('### Structure du livrable', '### Mise en forme'),
      extractSection('### Mise en forme du livrable (OBLIGATOIRE)', '### Checklist interne'),
      extractSection('### Checklist interne (NE PAS inclure dans le livrable)', '### Ce qu\'on NE fait PAS'),
      extractSection('### Ce qu\'on NE fait PAS', '## Entrée attendue'),
    ].join('\n\n'),

    // A6: Formatter — structure du livrable + mise en forme
    formatter: [
      extractSection('### Structure du livrable', '### Mise en forme'),
      extractSection('### Mise en forme du livrable (OBLIGATOIRE)', '### Checklist interne'),
    ].join('\n\n'),
  };
}

module.exports = { loadSkill, extractSection, getSectionsForAgents };
