import { createHash, timingSafeEqual } from 'node:crypto';
import { ConvexHttpClient } from 'convex/browser';

interface ApiRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  json(value: unknown): void;
  end(): void;
}

interface StateRecord {
  config: Record<string, unknown>;
  version: number;
  controlKeyHash: string;
  updatedAt: number;
}

interface PersistentStateClient {
  query(name: unknown, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: unknown, args: Record<string, unknown>): Promise<unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __aynBroadcastStates: Map<string, StateRecord> | undefined;
}

const states = globalThis.__aynBroadcastStates ?? new Map<string, StateRecord>();
globalThis.__aynBroadcastStates = states;

const MAX_STATIONS = 500;
const MAX_CONFIG_BYTES = 128_000;
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let persistentClient: PersistentStateClient | null | undefined;

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function normalizeStation(value: string): string | null {
  const station = value.toLowerCase().trim();
  return /^[a-z0-9-]{6,48}$/.test(station) ? station : null;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function prune(): void {
  const now = Date.now();
  for (const [station, record] of states) {
    if (now - record.updatedAt > STATE_TTL_MS) states.delete(station);
  }
  while (states.size > MAX_STATIONS) {
    const oldest = Array.from(states.entries()).sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) break;
    states.delete(oldest[0]);
  }
}

function parseBody(body: unknown): { config: Record<string, unknown>; controlKey: string } | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as { config?: unknown; controlKey?: unknown };
  if (!candidate.config || typeof candidate.config !== 'object' || Array.isArray(candidate.config)) return null;
  if (typeof candidate.controlKey !== 'string' || candidate.controlKey.length < 20 || candidate.controlKey.length > 200) return null;
  const serialized = JSON.stringify(candidate.config);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CONFIG_BYTES) return null;
  return { config: candidate.config as Record<string, unknown>, controlKey: candidate.controlKey };
}

function getPersistentClient(): PersistentStateClient | null {
  if (persistentClient !== undefined) return persistentClient;
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    persistentClient = null;
    return null;
  }
  persistentClient = new ConvexHttpClient(convexUrl, {
    fetch: (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) }),
  }) as PersistentStateClient;
  return persistentClient;
}

function normalizePersistentRecord(value: unknown): StateRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StateRecord>;
  if (!candidate.config || typeof candidate.config !== 'object' || Array.isArray(candidate.config)) return null;
  if (typeof candidate.controlKeyHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.controlKeyHash)) return null;
  const version = Number(candidate.version);
  const updatedAt = Number(candidate.updatedAt);
  if (!Number.isFinite(version) || !Number.isFinite(updatedAt)) return null;
  return {
    config: candidate.config as Record<string, unknown>,
    version,
    controlKeyHash: candidate.controlKeyHash,
    updatedAt,
  };
}

async function readState(station: string): Promise<StateRecord | null> {
  const client = getPersistentClient();
  if (!client) return states.get(station) ?? null;
  const value = await client.query('broadcastState:getState' as never, { station });
  const record = normalizePersistentRecord(value);
  if (record) states.set(station, record);
  else states.delete(station);
  return record;
}

async function writeState(station: string, record: StateRecord): Promise<StateRecord> {
  const client = getPersistentClient();
  if (!client) {
    states.set(station, record);
    return record;
  }
  const result = await client.mutation('broadcastState:putState' as never, {
    station,
    config: record.config,
    version: record.version,
    controlKeyHash: record.controlKeyHash,
    updatedAt: record.updatedAt,
  }) as { version?: unknown } | null;
  const stored = {
    ...record,
    version: Number.isFinite(Number(result?.version)) ? Number(result?.version) : record.version,
  };
  states.set(station, stored);
  return stored;
}

function persistentFailure(res: ApiResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('INVALID_CONTROL_KEY')) {
    res.status(403).json({ error: 'invalid_control_key' });
    return;
  }
  console.error('[broadcast-state] persistent store unavailable', error);
  res.setHeader('Retry-After', '2');
  res.status(503).json({ error: 'broadcast_state_unavailable' });
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const station = normalizeStation(single(req.query?.station));
  if (!station) {
    res.status(400).json({ error: 'invalid_station' });
    return;
  }

  prune();

  if (req.method === 'GET') {
    let record: StateRecord | null;
    try {
      record = await readState(station);
    } catch (error) {
      persistentFailure(res, error);
      return;
    }
    if (!record) {
      res.status(404).json({ error: 'station_not_found' });
      return;
    }
    const after = Number(single(req.query?.after));
    if (Number.isFinite(after) && after >= record.version) {
      res.status(204).end();
      return;
    }
    res.status(200).json({ config: record.config, version: record.version, updatedAt: record.updatedAt });
    return;
  }

  if (req.method !== 'PUT') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = parseBody(req.body);
  if (!parsed) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }

  const suppliedHash = hashKey(parsed.controlKey);
  let existing: StateRecord | null;
  try {
    existing = await readState(station);
  } catch (error) {
    persistentFailure(res, error);
    return;
  }
  if (existing && !secureEqual(existing.controlKeyHash, suppliedHash)) {
    res.status(403).json({ error: 'invalid_control_key' });
    return;
  }

  const version = Math.max(Date.now(), Number((parsed.config as { updatedAt?: unknown }).updatedAt || 0));
  try {
    const stored = await writeState(station, {
      config: parsed.config,
      version,
      controlKeyHash: existing?.controlKeyHash || suppliedHash,
      updatedAt: Date.now(),
    });
    prune();
    res.status(200).json({ ok: true, station, version: stored.version });
  } catch (error) {
    persistentFailure(res, error);
  }
}
