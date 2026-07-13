import { createHash, timingSafeEqual } from 'node:crypto';
import { Redis } from '@upstash/redis';

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

declare global {
  // eslint-disable-next-line no-var
  var __aynBroadcastStates: Map<string, StateRecord> | undefined;
}

const states = globalThis.__aynBroadcastStates ?? new Map<string, StateRecord>();
globalThis.__aynBroadcastStates = states;

const MAX_STATIONS = 500;
const MAX_CONFIG_BYTES = 128_000;
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_MS = STATE_TTL_SECONDS * 1_000;
const REDIS_PREFIX = 'ayn:broadcast:v2';
let redisClient: Redis | null | undefined;

class InvalidControlKeyError extends Error {
  constructor() {
    super('INVALID_CONTROL_KEY');
    this.name = 'InvalidControlKeyError';
  }
}

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

function getRedis(): Redis | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    redisClient = null;
    return null;
  }
  redisClient = new Redis({
    url,
    token,
    ...(process.env.NODE_TEST_CONTEXT ? { retry: false as const } : {}),
  });
  return redisClient;
}

function stateKey(station: string): string {
  return `${REDIS_PREFIX}:state:${station}`;
}

function ownerKey(station: string): string {
  return `${REDIS_PREFIX}:owner:${station}`;
}

function versionKey(station: string): string {
  return `${REDIS_PREFIX}:version:${station}`;
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
  const redis = getRedis();
  if (!redis) return states.get(station) ?? null;
  const record = normalizePersistentRecord(await redis.get(stateKey(station)));
  if (record) states.set(station, record);
  else states.delete(station);
  return record;
}

async function claimOwner(redis: Redis, station: string, controlKeyHash: string): Promise<void> {
  await redis.set(ownerKey(station), controlKeyHash, {
    nx: true,
    ex: STATE_TTL_SECONDS,
  });
  const owner = await redis.get<string>(ownerKey(station));
  if (typeof owner !== 'string' || !secureEqual(owner, controlKeyHash)) {
    throw new InvalidControlKeyError();
  }
}

async function writeState(station: string, record: StateRecord): Promise<StateRecord> {
  const redis = getRedis();
  if (!redis) {
    const existing = states.get(station);
    const stored = {
      ...record,
      version: Math.max(record.version, (existing?.version ?? 0) + 1),
    };
    states.set(station, stored);
    return stored;
  }

  await claimOwner(redis, station, record.controlKeyHash);
  const existing = normalizePersistentRecord(await redis.get(stateKey(station)));
  if (existing && !secureEqual(existing.controlKeyHash, record.controlKeyHash)) {
    throw new InvalidControlKeyError();
  }

  const version = Number(await redis.incr(versionKey(station)));
  const stored: StateRecord = {
    ...record,
    version: Number.isFinite(version) ? version : Math.max(record.version, (existing?.version ?? 0) + 1),
  };
  await Promise.all([
    redis.set(stateKey(station), stored, { ex: STATE_TTL_SECONDS }),
    redis.expire(ownerKey(station), STATE_TTL_SECONDS),
    redis.expire(versionKey(station), STATE_TTL_SECONDS),
  ]);
  states.set(station, stored);
  return stored;
}

function persistentFailure(res: ApiResponse, error: unknown): void {
  if (error instanceof InvalidControlKeyError) {
    res.status(403).json({ error: 'invalid_control_key' });
    return;
  }
  console.error('[broadcast-state] persistent Redis store unavailable', error);
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
