/**
 * Test script: verify which Tower AI endpoints support function calling (tools)
 * Tests: vertexai (gemini), openai (gpt-4o), newapi (deepseek)
 * Run: node scripts/test-towerai-function-calling.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../.env');
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const TOKEN = env.TOWERAI_API_KEY ?? '';
const AUTH_TOKEN = env.TOWERAI_AUTH_TOKEN ?? '';
const BASE_URL = 'https://tower-ai.yottastudios.com';

const GREET_TOOL = {
  type: 'function',
  function: {
    name: 'greet',
    description: 'Greet a person by name',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name to greet' },
      },
      required: ['name'],
    },
  },
};

// chathub-style minimal headers. Adding Cookie / x-lobe-trace breaks /chat/openai with 500.
const authHeaders = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
  token: TOKEN,
  authorization: `Bearer ${TOKEN}`,
  ...(AUTH_TOKEN ? { 'x-lobe-chat-auth': AUTH_TOKEN } : {}),
};

/**
 * Test one endpoint for function calling support.
 * @param {object} opts
 * @param {string} opts.label   Display name
 * @param {string} opts.endpoint  Full URL
 * @param {string} opts.model
 * @param {Record<string,unknown>} [opts.extraFields]  Extra body fields (e.g. apiMode)
 */
async function testEndpoint({ label, endpoint, model, extraFields = {} }) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${label}]  model: ${model}`);
  console.log(`           endpoint: ${endpoint}`);
  console.log('='.repeat(60));

  // --- with tools ---
  const withToolsBody = {
    model,
    stream: true,
    messages: [{ role: 'user', content: 'Please call the greet function with name="LobeHub".' }],
    temperature: 1,
    top_p: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    tools: [GREET_TOOL],
    tool_choice: 'auto',
    ...extraFields,
  };

  console.log('\n→ Sending request WITH tools...');
  console.log('  Headers:', JSON.stringify(authHeaders, null, 2));
  console.log('  Body:', JSON.stringify(withToolsBody, null, 2));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(withToolsBody),
  });
  const text = await res.text();
  console.log(`← Status: ${res.status}  Content-Type: ${res.headers.get('content-type')}`);
  console.log('  Body preview:', text.slice(0, 300) || '(empty)');

  if (!res.ok) {
    // --- baseline without tools ---
    console.log('\n→ Sending baseline request WITHOUT tools...');
    const baseRes = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: 'Reply with just: OK' }],
        temperature: 1,
        top_p: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        ...extraFields,
      }),
    });
    const baseText = await baseRes.text();
    console.log(`← Baseline status: ${baseRes.status}`);
    console.log('  Baseline body:', baseText.slice(0, 300));

    if (baseRes.ok) {
      console.log(`\n❌ [${label}] Function calling NOT supported — baseline OK but tools rejected`);
    } else {
      console.log(`\n❌ [${label}] Endpoint unavailable or auth failure (even baseline failed)`);
    }
    return;
  }

  // Analyse SSE events
  const events = text.split('\n\n').filter(Boolean);
  let hasToolCall = false;
  let hasText = false;

  for (const block of events) {
    const lines = block.trim().split('\n');
    const eventLine = lines.find((l) => l.startsWith('event:'));
    const dataLine = lines.find((l) => l.startsWith('data:'));
    const eventType = eventLine?.slice(7).trim() ?? '(no event)';
    const data = dataLine?.slice(6).trim() ?? '';
    console.log(`  [event: ${eventType}]`, data.slice(0, 200));
    if (eventType.includes('tool') || eventType.includes('function')) hasToolCall = true;
    if (data.includes('tool_call') || data.includes('function_call')) hasToolCall = true;
    if (eventType === 'text') hasText = true;
  }

  if (hasToolCall) {
    console.log(`\n✅ [${label}] Function calling SUPPORTED`);
  } else if (hasText) {
    console.log(`\n❌ [${label}] Function calling NOT supported — only text events returned`);
  } else {
    console.log(`\n⚠️  [${label}] Unexpected response — check raw body above`);
  }
}

console.log('=== Tower AI Function Calling Test ===');
console.log('Token:', TOKEN.slice(0, 8) + '...');
console.log('Auth Token:', AUTH_TOKEN ? AUTH_TOKEN.slice(0, 8) + '...' : '(none)');

// vertexai endpoint — gemini / claude models
await testEndpoint({
  label: 'vertexai / gemini-3-flash-preview',
  endpoint: `${BASE_URL}/zi/webapi/chat/vertexai`,
  model: 'gemini-3-flash-preview',
});

await testEndpoint({
  label: 'vertexai / gemini-3.1-pro-preview',
  endpoint: `${BASE_URL}/zi/webapi/chat/vertexai`,
  model: 'gemini-3.1-pro-preview',
});

// openai endpoint — gpt models (chathub sends no apiMode for openai)
for (const model of ['gpt-5.4', 'gpt-5.2', 'gpt-4o']) {
  await testEndpoint({
    label: `openai / ${model}`,
    endpoint: `${BASE_URL}/zi/webapi/chat/openai`,
    model,
  });
}

// newapi endpoint — deepseek models
await testEndpoint({
  label: 'newapi / deepseek-v3-2',
  endpoint: `${BASE_URL}/zi/webapi/chat/newapi`,
  model: 'deepseek-v3-2',
  extraFields: { apiMode: 'chatCompletion' },
});

console.log('\n' + '='.repeat(60));
console.log('Done.');
