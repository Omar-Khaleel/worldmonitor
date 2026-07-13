import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STATION_VARIANT = '__broadcast_station_v2__';

interface StoredBroadcastState {
  config: unknown;
  version: number;
  controlKeyHash: string;
}

function stationUserId(station: string): string {
  return `__broadcast__:${station}`;
}

function parseStoredState(value: unknown): StoredBroadcastState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredBroadcastState>;
  if (!candidate.config || typeof candidate.config !== 'object') return null;
  if (!Number.isFinite(Number(candidate.version))) return null;
  if (typeof candidate.controlKeyHash !== 'string') return null;
  return {
    config: candidate.config,
    version: Number(candidate.version),
    controlKeyHash: candidate.controlKeyHash,
  };
}

export const getState = query({
  args: { station: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query('userPreferences')
      .withIndex('by_user_variant', (q) =>
        q.eq('userId', stationUserId(args.station)).eq('variant', STATION_VARIANT))
      .unique();
    if (!record || Date.now() - record.updatedAt > MAX_STATE_AGE_MS) return null;
    const state = parseStoredState(record.data);
    if (!state) return null;
    return {
      config: state.config,
      version: state.version,
      controlKeyHash: state.controlKeyHash,
      updatedAt: record.updatedAt,
    };
  },
});

export const putState = mutation({
  args: {
    station: v.string(),
    config: v.any(),
    version: v.number(),
    controlKeyHash: v.string(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = stationUserId(args.station);
    const existing = await ctx.db
      .query('userPreferences')
      .withIndex('by_user_variant', (q) =>
        q.eq('userId', userId).eq('variant', STATION_VARIANT))
      .unique();
    const existingState = parseStoredState(existing?.data);

    if (existingState && existingState.controlKeyHash !== args.controlKeyHash) {
      throw new Error('INVALID_CONTROL_KEY');
    }

    const version = existingState
      ? Math.max(args.version, existingState.version + 1)
      : args.version;
    const data: StoredBroadcastState = {
      config: args.config,
      version,
      controlKeyHash: existingState?.controlKeyHash || args.controlKeyHash,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        data,
        schemaVersion: 2,
        updatedAt: args.updatedAt,
        syncVersion: version,
      });
    } else {
      await ctx.db.insert('userPreferences', {
        userId,
        variant: STATION_VARIANT,
        data,
        schemaVersion: 2,
        updatedAt: args.updatedAt,
        syncVersion: version,
      });
    }
    return { version };
  },
});
