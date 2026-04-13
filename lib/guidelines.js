const fs = require('fs');
const path = require('path');

const GUIDELINES_BASE_PATH = path.join(__dirname, '..', 'data', 'GUIDELINES-BASE.md');

let _baseCache = null;

/**
 * Load base guidelines from local file (fallback)
 */
function loadBaseGuidelines() {
  if (!_baseCache) {
    try {
      _baseCache = fs.readFileSync(GUIDELINES_BASE_PATH, 'utf-8');
    } catch {
      _baseCache = '';
      console.warn('[guidelines] GUIDELINES-BASE.md not found');
    }
  }
  return _baseCache;
}

/**
 * Load client-specific guidelines from Supabase
 * @param {object} supabase - Supabase client
 * @param {string} clientSlug - e.g. 'gary-abitbol'
 * @returns {Promise<{ icp: string, guidelines: string, clientName: string }>}
 */
async function loadClientGuidelines(supabase, clientSlug) {
  const base = loadBaseGuidelines();

  if (!supabase || !clientSlug) {
    return { icp: '', guidelines: base, clientName: clientSlug || 'unknown' };
  }

  try {
    const { data, error } = await supabase
      .from('client_guidelines')
      .select('client_name, icp, guidelines_content')
      .eq('client_slug', clientSlug)
      .maybeSingle();

    if (error || !data) {
      console.warn(`[guidelines] No guidelines found for client "${clientSlug}", using base only`);
      return { icp: '', guidelines: base, clientName: clientSlug };
    }

    // Concatenate: base guidelines + client-specific guidelines
    const combined = `${base}\n\n---\n\n# Guidelines spécifiques — ${data.client_name}\n\n${data.guidelines_content}`;

    return {
      icp: data.icp || '',
      guidelines: combined,
      clientName: data.client_name,
    };
  } catch (err) {
    console.error(`[guidelines] Supabase error for "${clientSlug}":`, err.message);
    return { icp: '', guidelines: base, clientName: clientSlug };
  }
}

module.exports = { loadBaseGuidelines, loadClientGuidelines };
