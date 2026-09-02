const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const test = require('node:test');

const {
  ANTHROPIC_WORKSPACE_HEADER,
  getAnthropicWorkspaceHeaders,
} = require('../lib/anthropic-config');
const { createAnthropicClient } = require('../lib/anthropic');

const WORKSPACE_ID = 'wrkspc_test_workspace';

test('builds the workspace header only when a workspace is configured', () => {
  assert.deepEqual(getAnthropicWorkspaceHeaders({}), {});
  assert.deepEqual(getAnthropicWorkspaceHeaders({ ANTHROPIC_WORKSPACE_ID: '   ' }), {});
  assert.deepEqual(
    getAnthropicWorkspaceHeaders({ ANTHROPIC_WORKSPACE_ID: `  ${WORKSPACE_ID}  ` }),
    { [ANTHROPIC_WORKSPACE_HEADER]: WORKSPACE_ID },
  );
});

test('the Anthropic SDK sends the configured workspace on Messages requests', async (t) => {
  const originalFetch = globalThis.fetch;
  let observedHeaders;
  globalThis.fetch = async (input, init) => {
    observedHeaders = new Request(input, init).headers;
    return new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = createAnthropicClient({
    ANTHROPIC_API_KEY: 'sk-ant-test',
    ANTHROPIC_WORKSPACE_ID: WORKSPACE_ID,
  });
  await client.messages.create({
    model: 'claude-test',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'test' }],
  });

  assert.equal(observedHeaders.get(ANTHROPIC_WORKSPACE_HEADER), WORKSPACE_ID);
});

test('the direct Managed Agents client sends the configured workspace', async (t) => {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousWorkspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  const originalRequest = https.request;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.ANTHROPIC_WORKSPACE_ID = WORKSPACE_ID;

  https.request = (options, callback) => {
    assert.equal(options.headers[ANTHROPIC_WORKSPACE_HEADER], WORKSPACE_ID);

    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.write = () => {};
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit('data', '{}');
        response.emit('end');
      });
    };
    return request;
  };

  t.after(() => {
    https.request = originalRequest;
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
    if (previousWorkspaceId === undefined) delete process.env.ANTHROPIC_WORKSPACE_ID;
    else process.env.ANTHROPIC_WORKSPACE_ID = previousWorkspaceId;
  });

  const { archiveSession } = require('../lib/managed-agent');
  await archiveSession('session_test');
});
