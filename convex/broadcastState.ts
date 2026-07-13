import { mutation, query } from './_generated/server';
import { v } from 'convex/values';

const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const getState = query({
  args: { station: v.string() },
  handler: async (ctx, args) => {
    const record = await ctx.db
      .query('broadcastStates')
      .withIndex('by_station', (q) => q.eq('station', args.station))
      .unique();
    if (!record) return null;
    if (Date.now() - record.updatedAt > MAX_STATE_AGE_MS) return null;
    return {
      config: record.config,
      version: record.version,
      controlKeyHash: record.controlKeyHash,
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
    const existing = await ctx.db
      .query('broadcastStates')
      .withIndex('by_station', (q) => q.eq('station', args.station))
      .unique();

    if (existing && existing.controlKeyHash !== args.controlKeyHash) {
      throw new Error('INVALID_CONTROL_KEY');
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        config: args.config,
        version: Math.max(args.version, existing.version + 1),
        updatedAt: args.updatedAt,
      });
      return { version: Math.max(args.version, existing.version + 1) };
    }

    await ctx.db.insert('broadcastStates', {
      station: args.station,
      config: args.config,
      version: args.version,
      controlKeyHash: args.controlKeyHash,
      updatedAt: args.updatedAt,
    });
    return { version: args.version };
  },
});
