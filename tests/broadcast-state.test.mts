import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import handler from '../api/broadcast/state';

interface InvocationResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

async function invoke(
  method: string,
  query: Record<string, string>,
  body?: unknown,
): Promise<InvocationResult> {
  let statusCode = 200;
  let responseBody: unknown;
  const headers: Record<string, string> = {};
  const response = {
    setHeader(name: string, value: string): void {
      headers[name.toLowerCase()] = value;
    },
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(value: unknown): void {
      responseBody = value;
    },
    end(): void {
      responseBody = undefined;
    },
  };

  await handler({ method, query, body }, response);
  return { status: statusCode, headers, body: responseBody };
}

test('broadcast state publishes, polls, and rejects a different controller key', async () => {
  const station = `ayn-test-${Date.now().toString(36)}`;
  const controlKey = 'control-key-12345678901234567890';
  const config = {
    version: 2,
    updatedAt: Date.now(),
    channelName: 'عين الصقر',
    panelSnapshots: [
      { id: 'politics', title: 'الأخبار السياسية', items: ['خبر تجريبي مباشر'], updatedAt: Date.now() },
    ],
    tickerHeadlines: ['خبر تجريبي مباشر'],
    mediaSources: [],
    projectionUpdatedAt: Date.now(),
  };

  const put = await invoke('PUT', { station }, { config, controlKey });
  assert.equal(put.status, 200);
  assert.equal((put.body as { ok?: boolean }).ok, true);
  const version = Number((put.body as { version?: number }).version);
  assert.ok(Number.isFinite(version) && version > 0);

  const get = await invoke('GET', { station });
  assert.equal(get.status, 200);
  assert.equal((get.body as { config?: { channelName?: string } }).config?.channelName, 'عين الصقر');
  assert.deepEqual(
    (get.body as { config?: { tickerHeadlines?: string[] } }).config?.tickerHeadlines,
    ['خبر تجريبي مباشر'],
  );
  assert.match(get.headers['cache-control'] || '', /no-store/);

  const unchanged = await invoke('GET', { station, after: String(version) });
  assert.equal(unchanged.status, 204);
  assert.equal(unchanged.body, undefined);

  const forbidden = await invoke('PUT', { station }, {
    config: { ...config, updatedAt: Date.now() + 1 },
    controlKey: 'different-key-123456789012345678',
  });
  assert.equal(forbidden.status, 403);
  assert.equal((forbidden.body as { error?: string }).error, 'invalid_control_key');
});

test('an older delayed write cannot replace a newer live configuration', async () => {
  const station = `ayn-order-${Date.now().toString(36)}`;
  const controlKey = 'control-key-ordering-123456789012345';
  const base = Date.now() + 1_000;

  const newer = await invoke('PUT', { station }, {
    controlKey,
    config: {
      version: 2,
      updatedAt: base + 100,
      channelName: 'الإعداد الأحدث',
      tickerHeadlines: ['الخبر الأحدث'],
    },
  });
  assert.equal(newer.status, 200);

  const stale = await invoke('PUT', { station }, {
    controlKey,
    config: {
      version: 2,
      updatedAt: base,
      channelName: 'إعداد قديم وصل متأخراً',
      tickerHeadlines: ['خبر قديم'],
    },
  });
  assert.equal(stale.status, 200);
  assert.equal((stale.body as { ignored?: string }).ignored, 'stale_update');

  const current = await invoke('GET', { station });
  assert.equal(current.status, 200);
  assert.equal((current.body as { config?: { channelName?: string } }).config?.channelName, 'الإعداد الأحدث');
  assert.deepEqual(
    (current.body as { config?: { tickerHeadlines?: string[] } }).config?.tickerHeadlines,
    ['الخبر الأحدث'],
  );
});

test('broadcast state rejects invalid stations and oversized or malformed writes', async () => {
  const invalidStation = await invoke('GET', { station: '../admin' });
  assert.equal(invalidStation.status, 400);

  const invalidBody = await invoke('PUT', { station: 'ayn-valid-test' }, {
    config: [],
    controlKey: 'control-key-12345678901234567890',
  });
  assert.equal(invalidBody.status, 400);

  const oversized = await invoke('PUT', { station: 'ayn-large-test' }, {
    config: { payload: 'x'.repeat(140_000) },
    controlKey: 'control-key-12345678901234567890',
  });
  assert.equal(oversized.status, 400);
});

test('broadcast state remains compatible with the Vercel Edge runtime', async () => {
  const source = await readFile(new URL('../api/broadcast/state.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:/);
  assert.doesNotMatch(source, /\bBuffer\./);
  assert.match(source, /crypto\.subtle\.digest\(['"]SHA-256['"]/);
});
