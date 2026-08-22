import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
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

/**
 * One-time, idempotent migration from the India-era internal media budget keys to the
 * Dubai/AED-native keys. Safe to run repeatedly: canonical rows are left untouched.
 *
 * Run after deploying this backend:
 *   npx convex run admin:migrateMediaBudgetsToAed
 */
export const migrateMediaBudgetsToAed = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), updated: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").collect();
    const map: Record<string,
      "below_aed_5000" | "aed_5000_15000" | "aed_15000_30000" | "above_aed_30000"> = {
      below_1l: "below_aed_5000",
      "1_3l": "aed_5000_15000",
      "3_5l": "aed_15000_30000",
      above_5l: "above_aed_30000",
    };

    let updated = 0;
    for (const lead of all) {
      const replacement = map[lead.monthlyMediaBudget];
      if (!replacement) continue;
      await ctx.db.patch(lead._id, { monthlyMediaBudget: replacement });
      updated += 1;
    }

    return { scanned: all.length, updated };
  },
});

/** Verify whether any old budget keys remain after the migration. */
export const mediaBudgetMigrationStatus = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    legacy: v.number(),
    canonical: v.number(),
    unexpected: v.number(),
  }),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").collect();
    const legacy = new Set(["below_1l", "1_3l", "3_5l", "above_5l"]);
    const canonical = new Set([
      "below_aed_5000",
      "aed_5000_15000",
      "aed_15000_30000",
      "above_aed_30000",
    ]);

    let legacyCount = 0;
    let canonicalCount = 0;
    let unexpected = 0;
    for (const lead of all) {
      if (legacy.has(lead.monthlyMediaBudget)) legacyCount += 1;
      else if (canonical.has(lead.monthlyMediaBudget)) canonicalCount += 1;
      else unexpected += 1;
    }

    return {
      total: all.length,
      legacy: legacyCount,
      canonical: canonicalCount,
      unexpected,
    };
  },
});


/**
 * One-time backfill / manual reconciliation: queue every lead for the Google Sheets
 * mirror. Safe to run repeatedly because Apps Script upserts by submissionId.
 *
 *   npx convex run admin:queueAllLeadsForGoogleSheets
 */
export const queueAllLeadsForGoogleSheets = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), queued: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").withIndex("by_createdAt").order("asc").collect();

    for (let i = 0; i < all.length; i += 1) {
      const lead = all[i];
      await ctx.db.patch(lead._id, {
        googleSheetsSyncStatus: "pending",
        googleSheetsSyncAttempts: 0,
      });
      // One per second keeps the Apps Script lock happy and makes the backfill easy to
      // observe in the Sheet. Regular new leads still sync immediately.
      await ctx.scheduler.runAfter(i * 1000, internal.sheets.syncLead, { leadId: lead._id });
    }

    return { scanned: all.length, queued: all.length };
  },
});

/** Quick health summary for the mirror. */
export const googleSheetsMirrorStatus = internalQuery({
  args: {},
  returns: v.object({
    total: v.number(),
    pending: v.number(),
    synced: v.number(),
    failed: v.number(),
    neverQueued: v.number(),
  }),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").collect();
    let pending = 0, synced = 0, failed = 0, neverQueued = 0;
    for (const lead of all) {
      if (lead.googleSheetsSyncStatus === "pending") pending += 1;
      else if (lead.googleSheetsSyncStatus === "synced") synced += 1;
      else if (lead.googleSheetsSyncStatus === "failed") failed += 1;
      else neverQueued += 1;
    }
    return { total: all.length, pending, synced, failed, neverQueued };
  },
});
