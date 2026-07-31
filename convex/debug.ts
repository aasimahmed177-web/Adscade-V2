import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

/** Read-only helpers for automated verification. Internal: unreachable from a browser. */

export const recentLeads = internalQuery({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) =>
    await ctx.db.query("leads").withIndex("by_createdAt").order("desc").take(5),
});

export const countLeads = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("leads").collect()).length,
});
