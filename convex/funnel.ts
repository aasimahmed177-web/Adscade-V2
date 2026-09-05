import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { funnelEventNameValidator, offerValidator } from "./schema";

/**
 * Anonymous first-party funnel telemetry.
 *
 * The browser posts one tiny row per funnel stage to /track-event (see http.ts, which
 * does all validation and PII rejection before calling in here). Convex remains the
 * authoritative store for leads; this table is diagnostics only and is never read by
 * the landing page.
 *
 * Nothing here may write lead PII. http.ts guarantees the payload has already been
 * stripped of it, and the argument list below simply has nowhere to put it.
 */

export const recordEvent = internalMutation({
  args: {
    eventId: v.string(),
    sessionId: v.string(),
    eventName: funnelEventNameValidator,
    offer: v.optional(offerValidator),
    clientTimestamp: v.optional(v.number()),
    submissionId: v.optional(v.string()),
    ctaText: v.optional(v.string()),
    deviceCategory: v.optional(v.string()),
    landingPage: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    gclid: v.optional(v.string()),
    gbraid: v.optional(v.string()),
    wbraid: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  returns: v.object({ duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    // Idempotency: a retried beacon, a double-fired listener, or sendBeacon racing a
    // keepalive fetch must not produce two rows for the same event.
    const existing = await ctx.db
      .query("funnelEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existing !== null) return { duplicate: true };

    await ctx.db.insert("funnelEvents", {
      ...args,
      createdAt: Date.now(), // server clock; the client's own time is telemetry only
    });
    return { duplicate: false };
  },
});

/* ── diagnostics helpers, used by admin.ts and the test suite ─────── */

export const countEvents = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("funnelEvents").collect()).length,
});

export const listEvents = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, { limit }) =>
    await ctx.db.query("funnelEvents").withIndex("by_createdAt").order("desc").take(limit ?? 20),
});

export const purgeAllEvents = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("funnelEvents").collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/** Delete telemetry for one session — used to clean up after test runs. */
export const purgeSession = internalMutation({
  args: { sessionId: v.string() },
  returns: v.number(),
  handler: async (ctx, { sessionId }) => {
    const rows = await ctx.db
      .query("funnelEvents")
      .withIndex("by_session_createdAt", (q) => q.eq("sessionId", sessionId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
