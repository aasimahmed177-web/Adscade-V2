import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { activeInventoryValidator, mediaBudgetValidator } from "./schema";

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
    monthlyMediaBudget: mediaBudgetValidator,
    consent: v.literal(true), // consent is the only permitted value; false cannot be stored
    landingPage: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    gclid: v.optional(v.string()),
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
      return { submissionId: existing.submissionId, duplicate: true };
    }

    await ctx.db.insert("leads", {
      ...args,
      createdAt: Date.now(), // server clock; the client never supplies this
      status: "submitted", // the only status the intake path may write
    });

    return { submissionId: args.submissionId, duplicate: false };
  },
});
