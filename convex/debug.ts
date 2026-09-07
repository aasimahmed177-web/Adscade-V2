import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/** Helpers for automated verification. Internal: unreachable from a browser. */

/**
 * Remove the `offer` field from one lead, reproducing a row written before the field
 * existed. Every historical production row looks like this, and offerOf() must keep
 * reading them as acquisition leads — otherwise a content event type could match them.
 *
 * Test-only. It cannot be reached from a browser and takes an explicit lead id, so it
 * has no bulk effect.
 */
export const clearOfferForTest = internalMutation({
  args: { leadId: v.id("leads") },
  returns: v.null(),
  handler: async (ctx, { leadId }) => {
    await ctx.db.patch(leadId, { offer: undefined });
    return null;
  },
});

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
