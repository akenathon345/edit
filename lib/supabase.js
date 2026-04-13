const { createClient } = require('@supabase/supabase-js');

let _supabase;
let _warned = false;

function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) {
      if (!_warned) {
        console.warn('[supabase] SUPABASE_URL or SUPABASE_KEY missing — Supabase disabled');
        _warned = true;
      }
      return null;
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}

module.exports = { getSupabase };
