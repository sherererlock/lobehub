import { ModelProvider } from 'model-bank';
import OpenAI from 'openai';

import type { OpenAICompatibleFactoryOptions } from '../../core/openaiCompatibleFactory';
import { createOpenAICompatibleRuntime } from '../../core/openaiCompatibleFactory';

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
  baseURL: `${TOWERAI_DEFAULT_BASE_URL}/zi/webapi/chat/openai`,
  chatCompletion: {
    handlePayload: (payload) => {
      const { tools, tool_choice, ...rest } = payload as any;

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
      const token = process.env.TOWERAI_API_KEY || options.apiKey || '';
      const authToken = process.env.TOWERAI_AUTH_TOKEN || '';
      const debug = process.env.DEBUG_TOWERAI_CHAT_COMPLETION === '1';

      if (debug) {
        console.info(
          '[TowerAI] env check — token:',
          token ? 'set' : 'MISSING',
          '| authToken:',
          authToken ? 'set' : 'MISSING',
        );
      }

      const customFetch: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;

        if (!url.includes('/chat/completions')) return fetch(input, init);

        const body = init?.body ? JSON.parse(init.body as string) : {};
        const model = (body?.model as string) || '';
        const callerWantsStream = (body?.stream as boolean) ?? false;
        const endpoint = resolveTowerAIEndpoint(TOWERAI_DEFAULT_BASE_URL, model);
        const isVertexai = model.startsWith('gemini') || model.startsWith('claude');
        const isNewApi = isNewApiModel(model);

        // Match the official TowerAI SDK shape exactly (E:\workspace\GitRepository\TowerAI\src\client.ts).
        // No Authorization header, no Cookie, no x-lobe-trace.
        // X-lobe-chat-auth is always sent (empty string when not set).
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Token': token,
          'X-lobe-chat-auth': authToken ?? '',
          'accept': callerWantsStream ? 'text/event-stream' : 'application/json',
        };

        if (debug) {
          console.info('[TowerAI] → POST', endpoint, 'model:', model);
          console.info(
            '[TowerAI]   Token:',
            token.slice(0, 12),
            '...  x-lobe-chat-auth:',
            authToken ? authToken.slice(0, 12) + '...' : '(none)',
          );
        }

        // Match the official TowerAI SDK body shape. Sampler defaults are required;
        // omitting them causes the server to surface an empty error: {}.
        const towerBody: Record<string, unknown> = {
          model,
          messages: body.messages,
          stream: true,
          temperature:       body.temperature       ?? 1,
          top_p:             body.top_p             ?? 0,
          frequency_penalty: body.frequency_penalty ?? 0,
          presence_penalty:  body.presence_penalty  ?? 0,
        };
        if (body.max_tokens != null) towerBody.max_tokens = body.max_tokens;
        if (isNewApi) towerBody.apiMode = 'chatCompletion';
        if (body.enabledSearch != null && !isNewApi) towerBody.enabledSearch = body.enabledSearch;
        if (body.searchMode != null && isVertexai) towerBody.searchMode = body.searchMode;
        if (body.useModelBuiltinSearch != null && isVertexai) {
          towerBody.useModelBuiltinSearch = body.useModelBuiltinSearch;
        }
        // Only vertexai endpoint accepts native tools (FC models only — see handlePayload).
        if (isVertexai && body.tools) {
          towerBody.tools = body.tools;
          if (body.tool_choice != null) towerBody.tool_choice = body.tool_choice;
        }

        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(towerBody),
        });

        if (debug) {
          const preview = await res.clone().text();
          console.info('[TowerAI] ←', res.status, res.headers.get('content-type'));
          console.info('[TowerAI]  ', preview.slice(0, 300));
        }

        if (!res.ok || !res.body) {
          const errBody = await res.clone().text();
          console.error(`[TowerAI] ← ${res.status} ${endpoint} | ${errBody.slice(0, 500)}`);
          return res;
        }

        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('text/event-stream') && !ct.includes('text/plain')) {
          return res;
        }

        // Tower AI sometimes returns HTTP 200 with a JSON error body. Surface it as 502.
        const cloned = res.clone();
        const peek = await cloned.text();
        if (peek.trimStart().startsWith('{')) {
          console.error(`[TowerAI] ← 200/json-error ${endpoint} | ${peek.slice(0, 500)}`);
          return new Response(peek, {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
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
        apiKey: token || 'tower-ai',
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
