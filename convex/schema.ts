import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Adscade lead capture.
 *
 * One table, many offers. Every field is present in one of the live modals — nothing is
 * collected that the visitor was not shown. The `offer` discriminator says which funnel
 * a row came from; offer-specific answers are optional at this layer and made mandatory
 * by the HTTP endpoint that owns each offer (see http.ts).
 *
 * On qualification verdicts. real_estate_acquisition has NO scoring model: every valid
 * submission is stored and every stored lead is offered the calendar. That has not
 * changed. brokerage_content_engine does gate the calendar, so it stores exactly one
 * derived boolean, `contentQualified`, computed SERVER-SIDE from teamSize and
 * monthlyShoot. It is never accepted from the browser — http.ts rejects a payload that
 * even contains the key. Still deliberately absent everywhere: score, outcome,
 * disqualification reason, manual-review status.
 */

/**
 * The offer discriminator. One `leads` table serves every Adscade offer; this field is
 * the routing key that tells acquisition rows from content rows.
 *
 * OPTIONAL on the table, and deliberately so: every row written before this field existed
 * has no `offer` at all. Absent MUST be read as "real_estate_acquisition" — see
 * offerOf() in sheets.ts and admin.ts. Nothing backfills historical rows.
 */
export const OFFERS = ["real_estate_acquisition", "brokerage_content_engine"] as const;

export const offerValidator = v.union(
  v.literal("real_estate_acquisition"),
  v.literal("brokerage_content_engine"),
);

/**
 * Read a row's offer. ALWAYS use this instead of touching `.offer` directly — it is the
 * single place that knows an absent value means the acquisition funnel, which is true of
 * every lead and every telemetry row written before VSL-5 shipped.
 */
export function offerOf(row: { offer?: string }): (typeof OFFERS)[number] {
  return row.offer === "brokerage_content_engine"
    ? "brokerage_content_engine"
    : "real_estate_acquisition";
}

export const ACTIVE_INVENTORY = ["1_19", "20_49", "50_99", "100_plus"] as const;

/* ── brokerage_content_engine (VSL-5) answers ──────────────────────── */

export const TEAM_SIZE = ["1_4", "5_9", "10_19", "20_plus"] as const;

export const teamSizeValidator = v.union(
  v.literal("1_4"),
  v.literal("5_9"),
  v.literal("10_19"),
  v.literal("20_plus"),
);

export const MONTHLY_SHOOT = ["yes", "no"] as const;

export const monthlyShootValidator = v.union(v.literal("yes"), v.literal("no"));

// Canonical Dubai/AED values. New writes always use these four keys.
export const MEDIA_BUDGET = [
  "below_aed_5000",
  "aed_5000_15000",
  "aed_15000_30000",
  "above_aed_30000",
] as const;

// Legacy India-era keys are accepted only so old cached landing pages and the existing
// production rows remain valid during the migration. http.ts normalises every incoming
// legacy value to the canonical AED key before insert, so no new legacy rows are created.
export const LEGACY_MEDIA_BUDGET = ["below_1l", "1_3l", "3_5l", "above_5l"] as const;
export const ACCEPTED_MEDIA_BUDGET = [...MEDIA_BUDGET, ...LEGACY_MEDIA_BUDGET] as const;

export const activeInventoryValidator = v.union(
  v.literal("1_19"),
  v.literal("20_49"),
  v.literal("50_99"),
  v.literal("100_plus"),
);

// Table validator remains backward-compatible until every historical row has been
// migrated. Keeping the four legacy literals here is harmless because insertLead uses
// canonicalMediaBudgetValidator below, so writes can only land with AED-native keys.
export const mediaBudgetValidator = v.union(
  v.literal("below_aed_5000"),
  v.literal("aed_5000_15000"),
  v.literal("aed_15000_30000"),
  v.literal("above_aed_30000"),
  v.literal("below_1l"),
  v.literal("1_3l"),
  v.literal("3_5l"),
  v.literal("above_5l"),
);

export const canonicalMediaBudgetValidator = v.union(
  v.literal("below_aed_5000"),
  v.literal("aed_5000_15000"),
  v.literal("aed_15000_30000"),
  v.literal("above_aed_30000"),
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

/**
 * Anonymous first-party funnel telemetry. Deliberately a SEPARATE table from `leads`:
 * most abandoners never create a lead row at all, so abandonment cannot be measured by
 * adding columns to `leads`.
 *
 * This table must never carry lead PII — no name, email, phone, inventory answer, budget
 * answer, consent value or Calendly answer. http.ts rejects those keys outright rather
 * than silently dropping them, so a frontend mistake fails loudly instead of leaking.
 */
/**
 * Stage names are OFFER-NEUTRAL and shared by every funnel. A second offer does NOT get
 * its own parallel vocabulary — it is distinguished by the `offer` field below.
 *
 * Duplicating names per offer would mean duplicating the stage-to-stage rate arithmetic
 * in admin.funnelSummary for every offer added. Keeping one ladder plus a discriminator
 * means funnelSummary({ offer }) filters, and comparing two funnels is subtraction.
 *
 * `lead_qualified` is the one genuinely new stage: it fires between stored and redirect
 * for offers that gate the calendar on a server-side verdict. real_estate_acquisition
 * has no gate and never emits it, which is why the ladder in admin.ts skips it for that
 * offer rather than reporting a 0% step.
 *
 * The browser's own dataLayer/GTM vocabulary is separate and unchanged — the VSL-5 page
 * still pushes content_cta_click and friends. The page maps those onto these canonical
 * stages when it posts to /track-event.
 */
export const FUNNEL_EVENT_NAMES = [
  "landing_page_view",
  "initial_cta_click",
  "lead_modal_open",
  "lead_form_start",
  "lead_form_submit",
  "lead_form_stored",
  "lead_qualified",
  "calendly_redirect",
] as const;

export const funnelEventNameValidator = v.union(
  v.literal("landing_page_view"),
  v.literal("initial_cta_click"),
  v.literal("lead_modal_open"),
  v.literal("lead_form_start"),
  v.literal("lead_form_submit"),
  v.literal("lead_form_stored"),
  v.literal("lead_qualified"),
  v.literal("calendly_redirect"),
);

export const googleSheetsSyncStatusValidator = v.union(
  v.literal("pending"),
  v.literal("synced"),
  v.literal("failed"),
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

    // Which funnel produced this row. Absent on every pre-VSL-5 row; read it through
    // offerOf(lead), never directly, so historical rows resolve to acquisition.
    offer: v.optional(offerValidator),

    // identity + consent — common to every offer
    name: v.string(),
    email: v.string(),
    normalisedEmail: v.string(), // trimmed + lowercased; what we match on
    phone: v.string(), // exactly as the visitor typed it
    normalisedPhone: v.string(), // E.164 where derivable, else digits
    consent: v.boolean(), // always true; false never reaches the insert

    // ── real_estate_acquisition (VSL-4) answers ──────────────────────
    // OPTIONAL here only so brokerage_content_engine rows can exist in the same table.
    // This is NOT a relaxation of the acquisition contract: leads.insertLead still
    // requires both, so /submit-lead cannot write a row that is missing them. Every
    // historical acquisition row has both and stays valid.
    activeInventory: v.optional(activeInventoryValidator),
    monthlyMediaBudget: v.optional(mediaBudgetValidator),

    // ── brokerage_content_engine (VSL-5) answers ─────────────────────
    // Optional for the mirror-image reason: acquisition rows never have them.
    // leads.insertContentLead requires all three.
    companyName: v.optional(v.string()),
    teamSize: v.optional(teamSizeValidator),
    monthlyShoot: v.optional(monthlyShootValidator),
    // Server-computed verdict, never client-supplied. Decides whether the visitor was
    // shown the calendar. Stored so the Sheet and the funnel report agree with what the
    // visitor actually experienced, rather than recomputing it later from the answers.
    contentQualified: v.optional(v.boolean()),

    // attribution
    landingPage: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    gclid: v.optional(v.string()),
    // Google's cookieless click identifiers (iOS/app and web-to-app). The frontend has
    // always captured them; they are optional so every historical row stays valid.
    gbraid: v.optional(v.string()),
    wbraid: v.optional(v.string()),
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

    // Google Sheets reporting mirror. Convex remains authoritative; these fields exist
    // only so operators can see whether the asynchronous mirror is healthy.
    googleSheetsSyncStatus: v.optional(googleSheetsSyncStatusValidator),
    googleSheetsSyncAttempts: v.optional(v.number()),
    googleSheetsLastSyncedAt: v.optional(v.number()),
    googleSheetsLastError: v.optional(v.string()),
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
    .index("by_calendlyStatus", ["calendlyStatus", "calendlyLastSyncedAt"])
    // "show me one offer's leads, newest first" — the operational listing.
    .index("by_offer_createdAt", ["offer", "createdAt"]),

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
    gbraid: v.optional(v.string()),
    wbraid: v.optional(v.string()),
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
  /**
   * One compact anonymous row per funnel stage. See FUNNEL_EVENT_NAMES above.
   */
  funnelEvents: defineTable({
    eventId: v.string(),      // client-generated UUID; the idempotency key
    sessionId: v.string(),    // random per browser session; never a fingerprint
    eventName: funnelEventNameValidator,
    // Which funnel this stage belongs to. Optional so telemetry written before VSL-5
    // existed stays valid; absent means real_estate_acquisition, same rule as on leads.
    offer: v.optional(offerValidator),
    createdAt: v.number(),    // authoritative server clock
    clientTimestamp: v.optional(v.number()),
    submissionId: v.optional(v.string()), // only exists once the modal has opened
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
    userAgent: v.optional(v.string()), // truncated
  })
    .index("by_eventId", ["eventId"])                        // idempotency
    .index("by_createdAt", ["createdAt"])                    // lookback windows
    .index("by_session_createdAt", ["sessionId", "createdAt"]) // one visitor's journey
    .index("by_eventName_createdAt", ["eventName", "createdAt"])
    .index("by_submissionId", ["submissionId"])
    // funnelSummary({ offer }) walks one offer's ladder without scanning the other's.
    .index("by_offer_eventName_createdAt", ["offer", "eventName", "createdAt"]),

  calendlySyncState: defineTable({
    calendlyUserUri: v.optional(v.string()),
    calendlyOrganizationUri: v.optional(v.string()),
    // The acquisition event type. Kept as-is so existing docs and dashboards still read.
    calendlyEventTypeUri: v.optional(v.string()),
    calendlyEventTypeName: v.optional(v.string()),
    // Every event type this sync is watching, one entry per configured offer. Optional
    // because a run from before multi-offer support wrote no such field.
    calendlyTargets: v.optional(
      v.array(
        v.object({
          // A LIST: when two offers share one Calendly event type, that event genuinely
          // serves both and cannot distinguish their bookings. Recording both states the
          // ambiguity rather than silently crediting whichever offer resolved first.
          offers: v.array(offerValidator),
          uri: v.string(),
          name: v.optional(v.string()),
          source: v.string(), // "env" | "scheduling_url" | "name_lookup"
        }),
      ),
    ),
    lastRunAt: v.optional(v.number()),
    lastRunOk: v.optional(v.boolean()),
    lastRunSummary: v.optional(v.string()),
    lastError: v.optional(v.string()),
  }),
});
