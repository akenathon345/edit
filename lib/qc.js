// Sanitize text for API (remove surrogates, control chars)
function sanitizeForAPI(str) {
  if (!str) return '';
  return str
    .replace(/[\uD800-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .normalize('NFC');
}

// Models
const MODELS = {
  VISION: 'claude-sonnet-4-6',          // A1 (frames)
  ANALYSIS: 'claude-sonnet-4-6',        // A2, A5
  AUDIT: 'claude-opus-4-6',             // A3, A4
  FORMAT: 'claude-haiku-4-5-20251001',  // A6
};

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 15000]; // exponential backoff

function isRetryable(err) {
  const status = err?.status || err?.statusCode;
  if (status === 429 || status === 529 || status === 503) return true;
  if (err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT') return true;
  if (err?.message?.includes('overloaded')) return true;
  return false;
}

// Call Claude — supports multimodal content (images + text), with retry
async function callClaude(anthropic, { systemPrompt, content, maxTokens = 4000, model, temperature = 0.2 }) {
  const start = Date.now();

  // content can be a string (text-only) or an array (multimodal)
  const messages = [{
    role: 'user',
    content: typeof content === 'string'
      ? sanitizeForAPI(content)
      : content,
  }];

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model: model || MODELS.ANALYSIS,
        max_tokens: maxTokens,
        temperature,
        system: sanitizeForAPI(systemPrompt),
        messages,
      });

      const elapsed = Date.now() - start;
      const firstBlock = response.content?.[0];
      const rawText = (firstBlock && firstBlock.type === 'text') ? firstBlock.text : '';

      if (!rawText && response.stop_reason === 'max_tokens') {
        console.warn(`[callClaude] Response truncated (max_tokens) — ${response.usage?.output_tokens || 0} tokens out`);
      }

      return {
        rawText,
        elapsed,
        tokensIn: response.usage?.input_tokens || 0,
        tokensOut: response.usage?.output_tokens || 0,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const delay = RETRY_DELAYS[attempt] || 15000;
        console.warn(`[callClaude] Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms — ${err.status || err.code || err.message}`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

// Parse JSON from Claude response — tries multiple strategies
function parseAgentJSON(rawText) {
  // Strategy 1: extract from ```json ... ``` block
  const jsonBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try { return JSON.parse(jsonBlockMatch[1].trim()); } catch {}
  }

  // Strategy 2: find first { ... } or [ ... ] block
  const braceMatch = rawText.match(/(\{[\s\S]*\})/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[1].trim()); } catch {}
  }
  const bracketMatch = rawText.match(/(\[[\s\S]*\])/);
  if (bracketMatch) {
    try { return JSON.parse(bracketMatch[1].trim()); } catch {}
  }

  // Strategy 3: try the raw text directly
  try { return JSON.parse(rawText.trim()); } catch {}

  return null;
}

// QC: ask Claude to reformat broken output as valid JSON
async function qcReformatJSON(anthropic, rawText, expectedShape) {
  const result = await callClaude(anthropic, {
    systemPrompt: `Tu es un reformateur JSON. Tu recois un texte qui devrait etre du JSON mais qui est mal formate. Extrais les donnees et retourne du JSON valide.

FORMAT ATTENDU :
${expectedShape}

REGLES :
- Retourne UNIQUEMENT le JSON, rien d'autre
- Preserve tout le contenu, ne perds rien`,
    content: `TEXTE A REFORMATER EN JSON VALIDE :\n\n${rawText.substring(0, 8000)}`,
    maxTokens: 4000,
    model: MODELS.FORMAT,
  });

  return parseAgentJSON(result.rawText);
}

// Agent timeout (3 minutes per agent)
const AGENT_TIMEOUT_MS = 180_000;

function withTimeout(promise, ms, name) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`[${name}] Timeout après ${ms / 1000}s`)), ms)),
  ]);
}

// Execute agent with QC pipeline + Supabase logging
async function execAgent(anthropic, supabase, { runId, name, systemPrompt, content, maxTokens = 4000, model, temperature, expectedShape }) {
  console.log(`[${name}] Starting...`);

  // Log start
  if (supabase && runId) {
    try {
      await supabase.from('ve_edit_agent_logs').insert({
        run_id: runId, agent_name: name, model: model || MODELS.ANALYSIS, status: 'started',
      });
    } catch (err) { console.warn(`[${name}] Supabase log error:`, err?.message); }
  }

  const result = await withTimeout(
    callClaude(anthropic, { systemPrompt, content, maxTokens, model, temperature }),
    AGENT_TIMEOUT_MS,
    name,
  );

  // QC Pipeline: parse -> reformat -> fallback
  let parsed = parseAgentJSON(result.rawText);
  let qcStatus = 'ok';

  if (!parsed && expectedShape) {
    try {
      parsed = await qcReformatJSON(anthropic, result.rawText, expectedShape);
      qcStatus = 'reformatted';
      console.log(`[QC] ${name}: reformatted successfully`);
    } catch {
      qcStatus = 'fallback_raw';
      console.log(`[QC] ${name}: reformat failed, using raw text`);
    }
  } else if (!parsed) {
    qcStatus = 'raw_no_shape';
  }

  console.log(`[${name}] Done — ${result.tokensIn} in / ${result.tokensOut} out / ${result.elapsed}ms`);

  // Log completion
  if (supabase && runId) {
    try {
      await supabase.from('ve_edit_agent_logs').insert({
        run_id: runId, agent_name: name, model: model || MODELS.ANALYSIS,
        tokens_in: result.tokensIn, tokens_out: result.tokensOut,
        duration_ms: result.elapsed, status: qcStatus === 'ok' ? 'success' : qcStatus,
        output_raw: result.rawText.substring(0, 50000),
      });
    } catch (err) { console.warn(`[${name}] Supabase log error:`, err?.message); }
  }

  return { raw: result.rawText, parsed, qcStatus, tokensIn: result.tokensIn, tokensOut: result.tokensOut, elapsed: result.elapsed };
}

module.exports = { sanitizeForAPI, callClaude, parseAgentJSON, qcReformatJSON, execAgent, MODELS };
