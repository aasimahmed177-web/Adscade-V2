import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Adscade lead capture.
 *
 * One table. Every field here is present in the live five-field modal — nothing is
 * collected that the visitor was not shown, and nothing derived is stored.
 *
 * Deliberately ABSENT, and must stay absent: score, outcome, qualification verdict,
 * disqualification reason, manual-review status. The funnel has no scoring model; every
 * valid submission is stored and every stored lead is offered the calendar.
 */

export const ACTIVE_INVENTORY = ["1_19", "20_49", "50_99", "100_plus"] as const;
export const MEDIA_BUDGET = ["below_1l", "1_3l", "3_5l", "above_5l"] as const;

export const activeInventoryValidator = v.union(
  v.literal("1_19"),
  v.literal("20_49"),
  v.literal("50_99"),
  v.literal("100_plus"),
);

export const mediaBudgetValidator = v.union(
  v.literal("below_1l"),
  v.literal("1_3l"),
  v.literal("3_5l"),
  v.literal("above_5l"),
);

export default defineSchema({
  leads: defineTable({
    // identity
    submissionId: v.string(), // client-generated UUID; the idempotency key
    createdAt: v.number(), // server clock, ms epoch — never the client's

    // the five answers + consent
    name: v.string(),
    email: v.string(),
    normalisedEmail: v.string(), // trimmed + lowercased; what we match on
    phone: v.string(), // exactly as the visitor typed it
    normalisedPhone: v.string(), // E.164 where derivable, else digits
    activeInventory: activeInventoryValidator,
    monthlyMediaBudget: mediaBudgetValidator,
    consent: v.boolean(), // always true; false never reaches the insert

    // attribution
    landingPage: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    gclid: v.optional(v.string()),
    deviceCategory: v.optional(v.string()), // mobile | tablet | desktop
    userAgent: v.optional(v.string()), // truncated; see http.ts

    // operational — set by staff working the lead, never by the browser
    status: v.string(), // "submitted" on insert
  })
    .index("by_submissionId", ["submissionId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_normalisedEmail", ["normalisedEmail", "createdAt"])
    .index("by_normalisedPhone", ["normalisedPhone", "createdAt"]),
});
