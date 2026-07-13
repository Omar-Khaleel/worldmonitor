import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import stateHandler from '../../api/broadcast/state';
import translateHandler from '../../api/broadcast/translate';

const MAX_BODY_BYTES = 256_000;

interface DevApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): DevApiResponse;
  json(value: unknown): void;
  end(): void;
}

type ApiHandler = (
  request: {
    method?: string;
    query?: Record<string, string | string[] | undefined>;
    body?: unknown;
  },
  response: DevApiResponse,
) => Promise<void>;

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
    total += chunk.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request_body_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function buildQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function responseAdapter(response: ServerResponse): DevApiResponse {
  const adapter: DevApiResponse = {
    setHeader(name: string, value: string): void {
      response.setHeader(name, value);
    },
    status(code: number): DevApiResponse {
      response.statusCode = code;
      return adapter;
    },
    json(value: unknown): void {
      if (!response.hasHeader('Content-Type')) {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      response.end(JSON.stringify(value));
    },
    end(): void {
      response.end();
    },
  };
  return adapter;
}

async function dispatch(
  handler: ApiHandler,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const body = request.method === 'PUT' || request.method === 'POST' || request.method === 'PATCH'
      ? await readJsonBody(request)
      : undefined;
    await handler(
      {
        method: request.method,
        query: buildQuery(url),
        body,
      },
      responseAdapter(response),
    );
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'request_body_too_large';
    response.statusCode = tooLarge ? 413 : 400;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(JSON.stringify({ error: tooLarge ? 'request_body_too_large' : 'invalid_json_body' }));
  }
}

export function broadcastStationDevPlugin(): Plugin {
  return {
    name: 'ayn-broadcast-station-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url) return next();
        const port = server.config.server.port || 3000;
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        const path = url.pathname.replace(/\/$/, '');
        if (path === '/api/broadcast/state') {
          void dispatch(stateHandler as ApiHandler, request, response, url);
          return;
        }
        if (path === '/api/broadcast/translate') {
          void dispatch(translateHandler as ApiHandler, request, response, url);
          return;
        }
        next();
      });
    },
  };
}
