const AnthropicModule = require('@anthropic-ai/sdk');

let _client;

function getAnthropicClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('[anthropic] ANTHROPIC_API_KEY manquante');
    return null;
  }
  const AnthropicClass = AnthropicModule.default || AnthropicModule;
  _client = new AnthropicClass({ apiKey: key });
  if (!_client || !_client.messages) {
    console.error('[anthropic] Client invalide — verifier SDK version');
    _client = null;
    return null;
  }
  return _client;
}

module.exports = { getAnthropicClient };
