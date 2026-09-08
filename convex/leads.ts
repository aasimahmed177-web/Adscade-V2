import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  activeInventoryValidator,
  canonicalMediaBudgetValidator,
  monthlyShootValidator,
  teamSizeValidator,
} from "./schema";

/**
 * The authoritative writes. Internal only — the browser cannot call these, it can only
 * reach the HTTP actions in http.ts, which validate first.
 *
 * There is one mutation PER OFFER rather than one shared mutation with everything
 * optional. The schema has to make offer-specific answers optional so both row shapes
 * can live in one table; if the write path were equally permissive, that table-level
 * relaxation would silently become a relaxation of each funnel's actual contract. Two
 * strict mutations keep "what the schema can hold" and "what this offer must supply"
 * as separate questions.
 */
export const insertLead = internalMutation({
  args: {
    submissionId: v.string(),
    name: v.string(),
    email: v.string(),
    normalisedEmail: v.string(),
    phone: v.string(),
    normalisedPhone: v.string(),
    activeInventory: activeInventoryValidator,
    monthlyMediaBudget: canonicalMediaBudgetValidator,
    consent: v.literal(true), // consent is the only permitted value; false cannot be stored
    // Computed by the HTTP action from the honeypot, never supplied by the browser.
    suspect: v.optional(v.boolean()),
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
    deviceCategory: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  returns: v.object({
    submissionId: v.string(),
    duplicate: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Idempotency. A retried POST, a double-tap that beat the disabled button, or a
    // flaky connection that resent the same body must not create a second lead.
    const existing = await ctx.db
      .query("leads")
      .withIndex("by_submissionId", (q) => q.eq("submissionId", args.submissionId))
      .unique();

    if (existing !== null) {
      // A retried browser POST is also a useful opportunity to heal a failed/missing
      // Google Sheets mirror. The action reads the latest lead row when it actually runs.
      await ctx.db.patch(existing._id, {
        googleSheetsSyncStatus: "pending",
        googleSheetsSyncAttempts: 0,
      });
      await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId: existing._id });
      return { submissionId: existing.submissionId, duplicate: true };
    }

    const { suspect, ...lead } = args;
    const leadId = await ctx.db.insert("leads", {
      ...lead,
      offer: "real_estate_acquisition", // stamped from here on; older rows have none
      createdAt: Date.now(), // server clock; the client never supplies this
      // The intake path may write these three values and no others.
      status: suspect ? "suspect" : "submitted",
      calendlyStatus: "not_booked", // convex/calendly.ts owns every transition from here
      googleSheetsSyncVersion: 1,
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });

    // Atomic with the lead insert: if this mutation commits, the mirror action is
    // guaranteed to be queued. The visitor does not wait for the action to finish.
    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId });

    return { submissionId: args.submissionId, duplicate: false };
  },
});

/**
 * brokerage_content_engine (VSL-5) intake.
 *
 * Mirrors insertLead's idempotency and Sheets-queueing exactly. The one structural
 * difference is `contentQualified`: it is computed by http.ts from teamSize and
 * monthlyShoot and passed in here, never read from the browser's payload, and it is
 * returned to the caller for conversion reporting. All stored applications can book.
 */
export const insertContentLead = internalMutation({
  args: {
    submissionId: v.string(),
    name: v.string(),
    email: v.string(),
    normalisedEmail: v.string(),
    phone: v.string(),
    normalisedPhone: v.string(),
    companyName: v.string(),
    teamSize: teamSizeValidator,
    monthlyShoot: monthlyShootValidator,
    // Server-derived. http.ts is the only caller and computes this itself.
    contentQualified: v.boolean(),
    consent: v.literal(true),
    suspect: v.optional(v.boolean()),
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
    deviceCategory: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  },
  returns: v.object({
    submissionId: v.string(),
    duplicate: v.boolean(),
    contentQualified: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("leads")
      .withIndex("by_submissionId", (q) => q.eq("submissionId", args.submissionId))
      .unique();

    if (existing !== null) {
      // Same healing behaviour as the acquisition path: a retried POST re-queues a
      // failed mirror. The stored verdict is NOT recomputed — the visitor already saw
      // an outcome based on it, and a retry must not change what they were told.
      await ctx.db.patch(existing._id, {
        googleSheetsSyncStatus: "pending",
        googleSheetsSyncAttempts: 0,
      });
      await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId: existing._id });
      return {
        submissionId: existing.submissionId,
        duplicate: true,
        contentQualified: existing.contentQualified ?? false,
      };
    }

    const { suspect, ...lead } = args;
    const leadId = await ctx.db.insert("leads", {
      ...lead,
      offer: "brokerage_content_engine",
      createdAt: Date.now(),
      status: suspect ? "suspect" : "submitted",
      calendlyStatus: "not_booked",
      googleSheetsSyncVersion: 1,
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });

    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId });

    return {
      submissionId: args.submissionId,
      duplicate: false,
      contentQualified: args.contentQualified,
    };
  },
});
