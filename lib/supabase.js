const { createClient } = require('@supabase/supabase-js');

let _supabase;

function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );
  }
  return _supabase;
}

module.exports = { getSupabase };
