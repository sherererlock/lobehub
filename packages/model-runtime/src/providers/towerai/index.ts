import { readFileSync, writeFileSync } from 'node:fs';

import { ModelProvider } from 'model-bank';
import OpenAI from 'openai';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';
import { refreshTowerAITokens } from './auth';

export const TOWERAI_DEFAULT_BASE_URL = 'https://tower-ai.yottastudios.com';

export function resolveTowerAIEndpoint(baseUrl: string, model: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (model.startsWith('gemini') || model.startsWith('claude')) {
    return `${base}/zi/webapi/chat/vertexai`;
  }
  if (model.startsWith('deepseek')) {
    return `${base}/zi/webapi/chat/newapi`;
  }
  return `${base}/zi/webapi/chat/openai`;
}

function isNewApiModel(model: string): boolean {
  return model.startsWith('deepseek');
}

// Module-scope token state. Initialized from process.env on first read; mutated
// by the refresh flow so subsequent requests in the same process pick up the new
// values without restart.
let currentToken: string | undefined;
let currentAuthToken: string | undefined;

function getCurrentToken(): string {
  if (currentToken === undefined) currentToken = process.env.TOWERAI_API_KEY ?? '';
  return currentToken;
}

function getCurrentAuthToken(): string {
  if (currentAuthToken === undefined) currentAuthToken = process.env.TOWERAI_AUTH_TOKEN ?? '';
  return currentAuthToken;
}

// TowerAI returns this exact shape when the user's session/token has expired and
// the openai upstream credential lookup fails. Also matches the documented
// 600015 expiry sentinel (vertexai surfaces this differently).
function isTokenExpiryError(status: number, body: string): boolean {
  if (body.includes('600015') || body.includes('token过期')) return true;
  if (
    status === 500 &&
    body.includes('"errorType":500') &&
    body.includes('"provider":"openai"') &&
    body.includes('"error":{}')
  ) {
    return true;
  }
  return false;
}

// Best-effort: rewrite TOWERAI_API_KEY / TOWERAI_AUTH_TOKEN lines in .env at the
// repo root so the new tokens survive a server restart. Silent on failure.
function persistTokensToEnv(token: string, authToken: string) {
  const envPath = process.env.TOWERAI_ENV_FILE || '.env';
  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  const replace = (src: string, key: string, value: string) => {
    const re = new RegExp(`^${key}=.*$`, 'm');
    return re.test(src) ? src.replace(re, `${key}=${value}`) : `${src}\n${key}=${value}`;
  };
  let next = replace(content, 'TOWERAI_API_KEY', token);
  next = replace(next, 'TOWERAI_AUTH_TOKEN', authToken);
  if (next !== content) {
    try {
      writeFileSync(envPath, next, 'utf8');
      console.info(`[TowerAI] persisted refreshed tokens to ${envPath}`);
    } catch (e) {
      console.warn(`[TowerAI] failed to persist tokens to ${envPath}:`, (e as Error).message);
    }
  }
}

// Convert Tower AI SSE (event: text/stop/tool_calls) → OpenAI SSE (data: {...})
function toOpenAIStream(
  src: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-towerai-${Date.now()}`;
  let buf = '';
  let closed = false;
  let hadToolCalls = false;

  function emitChunk(
    ctrl: ReadableStreamDefaultController<Uint8Array>,
    content: string,
    finishReason: string | null,
  ) {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    };
    ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function processEvent(raw: string, ctrl: ReadableStreamDefaultController<Uint8Array>): boolean {
    const lines = raw.trim().split('\n');
    let eventType = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7).trim();
      else if (line.startsWith('data: ')) data = line.slice(6);
    }

    if (eventType === 'tool_calls' && data) {
      let toolCalls: any[];
      try {
        toolCalls = JSON.parse(data);
      } catch {
        return false;
      }
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ delta: { tool_calls: toolCalls }, finish_reason: null, index: 0 }],
      };
      ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      hadToolCalls = true;
      return false;
    }

    if (eventType === 'text' && data) {
      let content: string;
      try {
        content = JSON.parse(data);
      } catch {
        content = data;
      }
      emitChunk(ctrl, content, null);
    } else if (eventType === 'stop') {
      emitChunk(ctrl, '', hadToolCalls ? 'tool_calls' : 'stop');
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
      return true;
    }
    return false;
  }

  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (closed) return;
      const { done, value } = await reader.read();
      if (done) {
        if (buf.trim()) processEvent(buf, ctrl);
        if (!closed) ctrl.close();
        return;
      }
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim() && processEvent(part, ctrl)) {
          closed = true;
          return;
        }
      }
    },
  });
}

// Vertexai-endpoint models that support native function calling.
// Corresponds to abilities.functionCall: true in the towerai model bank.
const VERTEXAI_FUNCTION_CALL_MODELS = new Set([
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
]);

// JSON Schema fields that Vertex AI does not support in function declarations.
const VERTEXAI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'const',
  '$schema',
  '$id',
  '$ref',
  'definitions',
  '$defs',
  'examples',
  'default',
]);

function sanitizeSchemaForVertexAI(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeSchemaForVertexAI);

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (VERTEXAI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    result[k] = sanitizeSchemaForVertexAI(v);
  }
  return result;
}

function sanitizeToolsForVertexAI(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const t = tool as any;
    if (!t.function?.parameters) return tool;
    return {
      ...t,
      function: { ...t.function, parameters: sanitizeSchemaForVertexAI(t.function.parameters) },
    };
  });
}

export const params = {
  apiKey: 'tower-ai',
  baseURL: `${TOWERAI_DEFAULT_BASE_URL}/zi/webapi/chat/openai`,
  chatCompletion: {
    handlePayload: (payload) => {
      // Strip apiMode so responsesAPIModels (e.g. gpt-5.4) don't get forced into
      // Responses API — TowerAI only supports Chat Completions upstream.
      const { tools, tool_choice, apiMode, ...rest } = payload as any;

      const model = (rest.model as string) ?? '';
      const isVertexai = model.startsWith('gemini') || model.startsWith('claude');
      const hasTools = Array.isArray(tools) && tools.length > 0;

      // Preserve the caller's stream intent — customFetch uses it to decide whether to
      // return SSE or a synthesized JSON response. Tower AI itself is always streamed.
      if (hasTools && VERTEXAI_FUNCTION_CALL_MODELS.has(model)) {
        return {
          ...rest,
          tool_choice,
          tools: sanitizeToolsForVertexAI(tools),
        } as any;
      }

      const searchParams =
        hasTools && isVertexai ? { searchMode: 'smart', useModelBuiltinSearch: true } : {};

      return { ...rest, ...searchParams } as any;
    },
  },
  customClient: {
    createClient: (options) => {
      // Seed module-scope state from options on first call (allows per-call apiKey override).
      if (!currentToken && options.apiKey) currentToken = options.apiKey;
      const autoRefresh = process.env.TOWERAI_AUTO_REFRESH === '1';
      const debug = process.env.DEBUG_TOWERAI_CHAT_COMPLETION === '1';

      // If auto-refresh is enabled and no real token exists, proactively fetch one on first request.
      let initPromise: Promise<void> | null = null;
      const hasRealToken = getCurrentToken() && getCurrentToken() !== 'tower-ai';
      if (autoRefresh && !hasRealToken) {
        initPromise = (async () => {
          try {
            console.info('[TowerAI] no token found — proactively refreshing via puppeteer');
            const fresh = await refreshTowerAITokens();
            currentToken = fresh.token;
            if (fresh.authToken) currentAuthToken = fresh.authToken;
            persistTokensToEnv(currentToken, currentAuthToken ?? '');
          } catch (e) {
            console.error('[TowerAI] proactive refresh failed:', (e as Error).message);
          }
        })();
      }

      if (debug) {
        console.info(
          '[TowerAI] env — token:',
          getCurrentToken() ? 'set' : 'MISSING',
          '| authToken:',
          getCurrentAuthToken() ? 'set' : 'MISSING',
          '| autoRefresh:',
          autoRefresh,
        );
      }

      const customFetch: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;

        // Wait for proactive token refresh to complete before making any request.
        if (initPromise) {
          await initPromise;
          initPromise = null;
        }

        if (!url.includes('/chat/completions')) return fetch(input, init);

        const body = init?.body ? JSON.parse(init.body as string) : {};
        const model = (body?.model as string) || '';
        const callerWantsStream = (body?.stream as boolean) ?? false;
        const endpoint = resolveTowerAIEndpoint(TOWERAI_DEFAULT_BASE_URL, model);
        const isVertexai = model.startsWith('gemini') || model.startsWith('claude');
        const isNewApi = isNewApiModel(model);

        // Match the official TowerAI SDK body shape. Sampler defaults are required;
        // omitting them causes the server to surface an empty error: {}.
        const towerBody: Record<string, unknown> = {
          model,
          messages: body.messages,
          stream: true,
          temperature: body.temperature ?? 1,
          top_p: body.top_p ?? 0,
          frequency_penalty: body.frequency_penalty ?? 0,
          presence_penalty: body.presence_penalty ?? 0,
        };
        if (body.max_tokens != null) towerBody.max_tokens = body.max_tokens;
        if (isNewApi) towerBody.apiMode = 'chatCompletion';
        if (body.enabledSearch != null && !isNewApi) towerBody.enabledSearch = body.enabledSearch;
        if (body.searchMode != null && isVertexai) towerBody.searchMode = body.searchMode;
        if (body.useModelBuiltinSearch != null && isVertexai) {
          towerBody.useModelBuiltinSearch = body.useModelBuiltinSearch;
        }
        if (isVertexai && body.tools) {
          towerBody.tools = body.tools;
          if (body.tool_choice != null) towerBody.tool_choice = body.tool_choice;
        }
        const serializedBody = JSON.stringify(towerBody);

        // Inner request — runs the actual fetch with the *current* token state so
        // the refresh-and-retry path can re-invoke it after updating module state.
        // Match the official TowerAI SDK header shape (no Authorization / Cookie / x-lobe-trace).
        const doFetch = async () => {
          const tk = getCurrentToken();
          const at = getCurrentAuthToken();
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Token': tk,
            'X-lobe-chat-auth': at ?? '',
            'accept': callerWantsStream ? 'text/event-stream' : 'application/json',
          };
          if (debug) {
            console.info('[TowerAI] → POST', endpoint, 'model:', model);
            console.info(
              '[TowerAI]   Token:',
              tk.slice(0, 12),
              '...  x-lobe-chat-auth:',
              at ? at.slice(0, 12) + '...' : '(none)',
            );
          }
          return fetch(endpoint, { body: serializedBody, headers, method: 'POST' });
        };

        let res = await doFetch();

        if (debug) {
          const preview = await res.clone().text();
          console.info('[TowerAI] ←', res.status, res.headers.get('content-type'));
          console.info('[TowerAI]  ', preview.slice(0, 300));
        }

        if (!res.ok || !res.body) {
          const errBody = await res.clone().text();

          // Detect token expiry and auto-refresh once via puppeteer if enabled.
          // Treat any non-200 as a potential token issue — the refresh is idempotent
          // (cooldown-protected) and a successful retry is cheaper than a missed refresh.
          if (
            autoRefresh &&
            (isTokenExpiryError(res.status, errBody) || res.status === 401 || res.status === 403)
          ) {
            try {
              console.info('[TowerAI] token appears expired — attempting auto-refresh');
              const fresh = await refreshTowerAITokens();
              currentToken = fresh.token;
              if (fresh.authToken) currentAuthToken = fresh.authToken;
              persistTokensToEnv(currentToken, currentAuthToken ?? '');
              res = await doFetch();
              if (!res.ok || !res.body) {
                const retryBody = await res.clone().text();
                console.error(
                  `[TowerAI] ← ${res.status} (after refresh) ${endpoint} | ${retryBody.slice(0, 500)}`,
                );
                return res;
              }
              // fall through to success-path handling below
            } catch (e) {
              console.error('[TowerAI] auto-refresh failed:', (e as Error).message);
              return res;
            }
          } else {
            return res;
          }
        }

        // Tower AI sometimes returns HTTP 200 with a JSON error body (e.g. token expired).
        // Check for token expiry BEFORE surfacing as 502, so auto-refresh can retry.
        const cloned = res.clone();
        const peek = await cloned.text();
        if (peek.trimStart().startsWith('{')) {
          if (autoRefresh && isTokenExpiryError(res.status, peek)) {
            try {
              console.info('[TowerAI] token expired (200/json) — attempting auto-refresh');
              const fresh = await refreshTowerAITokens();
              currentToken = fresh.token;
              if (fresh.authToken) currentAuthToken = fresh.authToken;
              persistTokensToEnv(currentToken, currentAuthToken ?? '');
              res = await doFetch();
              // Re-read the new response
              const retryCloned = res.clone();
              const retryPeek = await retryCloned.text();
              // If still an error after refresh, surface it
              if (!res.ok || retryPeek.trimStart().startsWith('{')) {
                return new Response(retryPeek, {
                  status: res.ok ? 502 : res.status,
                  headers: { 'content-type': 'application/json' },
                });
              }
              // Fall through to success-path stream handling below
            } catch (e) {
              console.error('[TowerAI] auto-refresh failed:', (e as Error).message);
              return new Response(peek, {
                status: 502,
                headers: { 'content-type': 'application/json' },
              });
            }
          } else {
            return new Response(peek, {
              status: 502,
              headers: { 'content-type': 'application/json' },
            });
          }
        }

        if (callerWantsStream) {
          return new Response(toOpenAIStream(res.body, model), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        // Caller asked for non-streaming (e.g. title generation): collect the SSE and
        // assemble a single OpenAI ChatCompletion JSON. Tower AI is always streamed upstream.
        let content = '';
        let chatId = `chatcmpl-towerai-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        for (const block of peek.split('\n\n')) {
          let eventType = '';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('id: ')) chatId = line.slice(4).trim();
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (eventType === 'text' && data) {
            try {
              content += JSON.parse(data) as string;
            } catch {
              content += data;
            }
          }
        }

        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', index: 0, message: { content, role: 'assistant' } }],
            created,
            id: chatId,
            model,
            object: 'chat.completion',
            usage: { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 },
        );
      };

      return new OpenAI({
        ...options,
        apiKey: getCurrentToken() || 'tower-ai',
        baseURL: `${TOWERAI_DEFAULT_BASE_URL}/zi/webapi/chat/openai`,
        defaultHeaders: {},
        fetch: customFetch,
      });
    },
  },
  debug: {
    chatCompletion: () => process.env.DEBUG_TOWERAI_CHAT_COMPLETION === '1',
  },
  errorType: {
    bizError: 'TowerAIBizError',
    invalidAPIKey: 'InvalidTowerAIAPIKey',
  },
  provider: ModelProvider.TowerAI,
} satisfies OpenAICompatibleFactoryOptions;

export const LobeTowerAI = createOpenAICompatibleRuntime(params);
