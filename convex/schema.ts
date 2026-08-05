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

/**
 * Booking status, synced from Calendly by convex/calendly.ts on a five-minute poll
 * (Calendly's Free plan has no webhooks). See docs/CALENDLY_FREE_SYNC.md.
 *
 * "not_booked" is the default for every lead until a matching Calendly invitee is found.
 * Legacy rows written before this field existed have no calendlyStatus at all — sync
 * logic treats undefined the same as "not_booked", so nothing needs a backfill.
 */
export const calendlyStatusValidator = v.union(
  v.literal("not_booked"),
  v.literal("booked"),
  v.literal("canceled"),
  v.literal("rescheduled"),
);

/** One row of Calendly's invitee-side custom Q&A, stored verbatim. */
export const calendlyQAValidator = v.object({
  question: v.string(),
  answer: v.string(),
  position: v.optional(v.number()),
});

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

    // Calendly booking sync. All optional: absent until convex/calendly.ts's poll finds
    // a matching invitee. None of this reaches the browser — see http.ts, which never
    // reads or returns it.
    calendlyStatus: v.optional(calendlyStatusValidator),
    calendlyEventUri: v.optional(v.string()),
    calendlyInviteeUri: v.optional(v.string()), // the idempotency key — see calendly.ts
    calendlyEventTypeUri: v.optional(v.string()),
    calendlyBookedAt: v.optional(v.number()), // ms epoch; the FIRST booking, never overwritten
    calendlyStartTime: v.optional(v.number()),
    calendlyEndTime: v.optional(v.number()),
    calendlyCanceledAt: v.optional(v.number()),
    calendlyRescheduled: v.optional(v.boolean()),
    calendlyQuestionsAndAnswers: v.optional(v.array(calendlyQAValidator)),
    calendlyLastSyncedAt: v.optional(v.number()),
  })
    .index("by_submissionId", ["submissionId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_normalisedEmail", ["normalisedEmail", "createdAt"])
    .index("by_normalisedPhone", ["normalisedPhone", "createdAt"])
    // Idempotency lookup: "have we already processed this Calendly invitee?"
    .index("by_calendlyInviteeUri", ["calendlyInviteeUri"])
    // The cancellation/reschedule recheck pass rotates through open bookings oldest-
    // synced-first, so every booking eventually gets rechecked even if the per-run cap
    // is smaller than the number of upcoming meetings.
    .index("by_calendlyStatus", ["calendlyStatus", "calendlyLastSyncedAt"]),

  /**
   * A Calendly invitee that could not be matched to any lead — wrong/mistyped email, a
   * booking made without going through the funnel, or a lead whose only matching row was
   * already booked to something else. Never silently discarded; a human resolves these.
   */
  calendlyUnmatched: defineTable({
    inviteeUri: v.string(), // idempotency key — one row per invitee, updated not duplicated
    eventUri: v.string(),
    eventTypeUri: v.string(),
    inviteeEmail: v.string(), // normalised
    inviteeName: v.string(),
    startTime: v.number(),
    endTime: v.number(),
    questionsAndAnswers: v.array(calendlyQAValidator),
    // A same-name lead in a plausible submission window, surfaced as a hint for whoever
    // resolves this — never auto-linked. See docs/CALENDLY_FREE_SYNC.md "Matching".
    diagnosticCandidateLeadId: v.optional(v.id("leads")),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    resolved: v.boolean(), // set by staff once looked into; sync never sets this true
  }).index("by_inviteeUri", ["inviteeUri"]),

  /**
   * One row per Calendly invitee that was successfully matched to a lead — the "a real
   * booking happened" signal. Written once, from inside the same mutation that marks the
   * lead booked, so the two can never disagree about whether a booking occurred.
   *
   * Shaped for a future Google Ads offline/enhanced-conversion upload: gclid plus SHA-256
   * hashes of the normalised email and phone, exactly as Google's API expects them. The
   * raw values live on the lead row; nothing raw is duplicated here.
   */
  bookedCallEvents: defineTable({
    inviteeUri: v.string(), // idempotency key
    leadId: v.id("leads"),
    submissionId: v.string(), // for a human cross-referencing the dashboard
    gclid: v.optional(v.string()),
    hashedEmail: v.string(),
    hashedPhone: v.string(),
    calendlyBookedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_inviteeUri", ["inviteeUri"])
    .index("by_submissionId", ["submissionId"]),

  /**
   * Singleton. What the last successful sync resolved and did, so a human can tell from
   * the dashboard alone whether the poll is healthy without reading function logs.
   */
  calendlySyncState: defineTable({
    calendlyUserUri: v.optional(v.string()),
    calendlyOrganizationUri: v.optional(v.string()),
    calendlyEventTypeUri: v.optional(v.string()),
    calendlyEventTypeName: v.optional(v.string()),
    lastRunAt: v.optional(v.number()),
    lastRunOk: v.optional(v.boolean()),
    lastRunSummary: v.optional(v.string()),
    lastError: v.optional(v.string()),
  }),
});
