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
    let data = null;

    // Strategy 1: exact match
    const r1 = await supabase
      .from('client_guidelines')
      .select('client_name, icp, guidelines_content, client_slug')
      .eq('client_slug', clientSlug)
      .maybeSingle();
    data = r1.data;

    // Strategy 2: slug is a prefix (e.g. "nadia-fattah" matches "nadia-fattah-el-meknassi")
    if (!data) {
      const r2 = await supabase
        .from('client_guidelines')
        .select('client_name, icp, guidelines_content, client_slug')
        .ilike('client_slug', `${clientSlug}%`)
        .limit(1)
        .maybeSingle();
      if (r2.data) {
        data = r2.data;
        console.log(`[guidelines] Fuzzy match: "${clientSlug}" → "${data.client_slug}"`);
      }
    }

    // Strategy 3: Supabase slug is a prefix of the input (e.g. "carolina" matches "carolina-moreno")
    if (!data) {
      const parts = clientSlug.split('-');
      // Build progressively shorter prefixes: "carolina-moreno" → try "carolina"
      for (let len = parts.length - 1; len >= 1; len--) {
        const prefix = parts.slice(0, len).join('-');
        if (prefix.length < 3) continue;
        const r3 = await supabase
          .from('client_guidelines')
          .select('client_name, icp, guidelines_content, client_slug')
          .eq('client_slug', prefix)
          .maybeSingle();
        if (r3.data) {
          data = r3.data;
          console.log(`[guidelines] Fuzzy match (reverse prefix "${prefix}"): "${clientSlug}" → "${data.client_slug}"`);
          break;
        }
      }
    }

    if (!data) {
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
