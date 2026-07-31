import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/** Operational helpers. Internal only — unreachable from a browser. */

export const countLeads = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("leads").collect()).length,
});

export const listLeads = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, { limit }) =>
    await ctx.db.query("leads").withIndex("by_createdAt").order("desc").take(limit ?? 20),
});

/**
 * Delete leads whose stored user-agent marks them as automated verification traffic.
 * No browser sends "node" or "curl/..." — this cannot match a genuine visitor, which is
 * why it is safer than purging by date or deleting everything.
 */
export const purgeTestLeads = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").collect();
    const doomed = all.filter((l) => {
      const ua = l.userAgent ?? "";
      return ua === "node" || ua.startsWith("curl/") || ua.includes("HeadlessChrome");
    });
    for (const l of doomed) await ctx.db.delete(l._id);
    return doomed.length;
  },
});

/**
 * Delete leads whose submissionId begins with a prefix. Used to clear verification rows
 * written during launch testing so the sales queue starts clean.
 */
export const purgeBySubmissionIdPrefix = internalMutation({
  args: { prefix: v.string() },
  returns: v.number(),
  handler: async (ctx, { prefix }) => {
    if (prefix.length < 4) throw new Error("refusing to purge on a short prefix");
    const all = await ctx.db.query("leads").collect();
    const doomed = all.filter((l) => l.submissionId.startsWith(prefix));
    for (const l of doomed) await ctx.db.delete(l._id);
    return doomed.length;
  },
});
