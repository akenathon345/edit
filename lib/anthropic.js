const AnthropicModule = require('@anthropic-ai/sdk');
const { getAnthropicWorkspaceHeaders } = require('./anthropic-config');

let _client;

function createAnthropicClient(env = process.env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error('[anthropic] ANTHROPIC_API_KEY manquante');
    return null;
  }
  const AnthropicClass = AnthropicModule.default || AnthropicModule;
  const workspaceHeaders = getAnthropicWorkspaceHeaders(env);
  const client = new AnthropicClass({
    apiKey: key,
    ...(Object.keys(workspaceHeaders).length > 0 && { defaultHeaders: workspaceHeaders }),
  });
  if (!client || !client.messages) {
    console.error('[anthropic] Client invalide — verifier SDK version');
    return null;
  }
  return client;
}

function getAnthropicClient() {
  if (_client) return _client;
  _client = createAnthropicClient();
  return _client;
}

module.exports = { createAnthropicClient, getAnthropicClient };
