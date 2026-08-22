import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { activeInventoryValidator, canonicalMediaBudgetValidator } from "./schema";

/**
 * The authoritative write. Internal only — the browser cannot call this, it can only
 * reach the HTTP action in http.ts, which validates first.
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
      createdAt: Date.now(), // server clock; the client never supplies this
      // The intake path may write these three values and no others.
      status: suspect ? "suspect" : "submitted",
      calendlyStatus: "not_booked", // convex/calendly.ts owns every transition from here
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });

    // Atomic with the lead insert: if this mutation commits, the mirror action is
    // guaranteed to be queued. The visitor does not wait for the action to finish.
    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId });

    return { submissionId: args.submissionId, duplicate: false };
  },
});
