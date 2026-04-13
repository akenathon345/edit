/**
 * Managed Agent — Appel API Anthropic Sessions (beta)
 *
 * Utilise les endpoints REST directement (pas le SDK)
 * pour appeler un agent déployé via l'API managed-agents.
 */

const https = require('https');

const API_BASE = 'https://api.anthropic.com';
const BETA_VERSION = 'managed-agents-2026-04-01';
const AGENT_ID = process.env.MANAGED_AGENT_ID || 'agent_011CZvF95qaCLD1GvTF3FL7p';
const ENV_ID = process.env.MANAGED_AGENT_ENV_ID || 'env_01TjkGQxUFXPhWC6n7GqJbRH';

// ── HTTP helper ──────────────────────────────────────────────────────────

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.MANAGED_AGENT_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('MANAGED_AGENT_API_KEY manquante'));

    const options = {
      hostname: 'api.anthropic.com',
      path,
      method,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_VERSION,
        'content-type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`API ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── SSE Stream reader ────────────────────────────────────────────────────

function streamEvents(sessionId) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.MANAGED_AGENT_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('MANAGED_AGENT_API_KEY manquante'));

    const options = {
      hostname: 'api.anthropic.com',
      path: `/v1/sessions/${sessionId}/events/stream`,
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': BETA_VERSION,
        'accept': 'text/event-stream',
      },
    };

    const results = [];
    let lastError = null;
    let stopReason = null;

    const req = https.request(options, (res) => {
      if (res.statusCode >= 400) {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => reject(new Error(`Stream ${res.statusCode}: ${data}`)));
        return;
      }

      // Anthropic SSE: "event: message\ndata: {json}\n\n"
      // Each data: line is a complete JSON object on one line.
      // We process line-by-line, trying to parse each data: line as JSON.
      // If it fails (partial chunk), we accumulate until we get valid JSON.
      let lineBuffer = '';
      let dataAccum = '';

      res.on('data', (chunk) => {
        lineBuffer += chunk.toString();

        // Process complete lines
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          // Accumulate data: lines
          if (line.startsWith('data: ')) {
            dataAccum += line.slice(6);
            // Try to parse immediately
            try {
              const data = JSON.parse(dataAccum);
              dataAccum = ''; // reset on success

              if (data.type === 'agent.message' && data.content) {
                for (const block of data.content) {
                  if (block.type === 'text') {
                    results.push(block.text);
                    console.log(`[managed-agent] Got text block (${block.text.length} chars)`);
                  }
                }
              }

              if (data.type === 'session.error') {
                lastError = data.error || data;
                console.error('[managed-agent] Error:', JSON.stringify(lastError));
              }

              if (data.type === 'session.status_idle') {
                stopReason = data.stop_reason || null;
                console.log('[managed-agent] Session idle, stop_reason:', JSON.stringify(stopReason));
                req.destroy();
                resolve({ results, lastError, stopReason });
                return;
              }
            } catch {
              // JSON incomplete — accumulate more data: lines
            }
          } else if (line.trim() === '' || line.startsWith('event:')) {
            // Blank line (event boundary) or event type — reset data accumulator if no valid parse
            if (dataAccum) {
              // Try one last parse
              try {
                const data = JSON.parse(dataAccum);
                if (data.type === 'agent.message' && data.content) {
                  for (const block of data.content) {
                    if (block.type === 'text') {
                      results.push(block.text);
                      console.log(`[managed-agent] Got text block (${block.text.length} chars)`);
                    }
                  }
                }
                if (data.type === 'session.status_idle') {
                  stopReason = data.stop_reason || null;
                  req.destroy();
                  resolve({ results, lastError, stopReason });
                  return;
                }
              } catch {
                console.log(`[managed-agent] Skipped unparseable data (${dataAccum.length} chars)`);
              }
              dataAccum = '';
            }
          }
        }
      });

      res.on('end', () => {
        resolve({ results, lastError, stopReason });
      });
    });

    // Timeout 15 minutes (agent peut être long)
    req.setTimeout(15 * 60 * 1000, () => {
      req.destroy();
      resolve({ results, lastError: { type: 'timeout', message: 'Stream timeout 15min' }, stopReason: 'timeout' });
    });

    req.on('error', (err) => {
      if (results.length > 0) {
        resolve({ results, lastError: err, stopReason: 'error' });
      } else {
        reject(err);
      }
    });

    req.end();
  });
}

// ── Main function ────────────────────────────────────────────────────────

/**
 * Appelle le managed agent avec un input et retourne la réponse.
 * Gère le retry automatique en cas de rate limit.
 *
 * @param {string} input - Le texte à envoyer à l'agent (ex: transcription)
 * @param {object} options
 * @param {number} options.maxRetries - Nombre max de retries (défaut: 3)
 * @param {string} options.agentId - Override l'agent ID
 * @param {string} options.envId - Override l'environment ID
 * @returns {Promise<{sessionId: string, text: string, error: string|null}>}
 */
async function callManagedAgent(input, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const agentId = options.agentId || AGENT_ID;
  const envId = options.envId || ENV_ID;

  // 1. Créer la session
  console.log('[managed-agent] Création session...');
  const session = await apiRequest('POST', '/v1/sessions', {
    agent: agentId,
    environment_id: envId,
  });
  const sessionId = session.id;
  console.log(`[managed-agent] Session: ${sessionId}`);

  const allResults = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 2. Envoyer le message
    const messageText = attempt === 0
      ? `mon input : ${input}`
      : 'Continue ta réponse où tu t\'es arrêté.';

    console.log(`[managed-agent] Envoi message (attempt ${attempt + 1})...`);
    await apiRequest('POST', `/v1/sessions/${sessionId}/events`, {
      events: [{
        type: 'user.message',
        content: [{ type: 'text', text: messageText }],
      }],
    });

    // 3. Streamer les réponses
    console.log('[managed-agent] Stream en cours...');
    const { results, lastError, stopReason } = await streamEvents(sessionId);
    allResults.push(...results);

    // Succès — pas d'erreur ou fin normale
    if (!lastError) {
      console.log(`[managed-agent] Terminé. ${allResults.length} blocs de texte.`);
      return {
        sessionId,
        text: allResults.join(''),
        error: null,
      };
    }

    // Rate limit — retry avec backoff
    const isRateLimit = lastError.type === 'model_rate_limited_error'
      || (lastError.message || '').includes('rate_limit');

    if (isRateLimit && attempt < maxRetries) {
      const wait = 30 * Math.pow(2, attempt); // 30s, 60s, 120s
      console.log(`[managed-agent] Rate limited. Retry ${attempt + 1}/${maxRetries} dans ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    // Autre erreur ou retries épuisés
    console.error(`[managed-agent] Erreur finale:`, lastError);
    return {
      sessionId,
      text: allResults.join(''),
      error: lastError.message || JSON.stringify(lastError),
    };
  }

  return {
    sessionId,
    text: allResults.join(''),
    error: 'Max retries épuisé',
  };
}

/**
 * Appelle le managed agent et envoie le résultat à un callback URL.
 *
 * @param {string} input - Texte à envoyer
 * @param {string} callbackUrl - URL qui recevra le résultat en POST
 * @param {object} options - Options (maxRetries, agentId, envId, metadata)
 */
async function callManagedAgentWithCallback(input, callbackUrl, options = {}) {
  let result;
  try {
    result = await callManagedAgent(input, options);
  } catch (err) {
    result = { sessionId: null, text: '', error: err.message };
  }

  // Envoyer le callback
  const payload = {
    session_id: result.sessionId,
    analysis: result.text,
    error: result.error,
    ...(options.metadata || {}),
  };

  try {
    const url = new URL(callbackUrl);
    const proto = url.protocol === 'https:' ? https : require('http');

    await new Promise((resolve, reject) => {
      const req = proto.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          console.log(`[managed-agent] Callback ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve();
        });
      });
      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
  } catch (err) {
    console.error(`[managed-agent] Callback failed:`, err.message);
  }

  return result;
}

/**
 * Archiver une session terminée.
 */
async function archiveSession(sessionId) {
  return apiRequest('POST', `/v1/sessions/${sessionId}/archive`);
}

module.exports = {
  callManagedAgent,
  callManagedAgentWithCallback,
  archiveSession,
};
