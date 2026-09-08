import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { calendlyQAValidator, calendlyStatusValidator, offerOf, offerValidator } from "./schema";
import {
  getCurrentUser,
  listEventTypes,
  listActiveEvents,
  listInvitees,
  getInvitee,
  getEvent,
} from "./calendlyClient";
import { sha256Hex } from "./calendlyHash";

/**
 * Calendly Free-plan booking sync.
 *
 * Free plan has no webhooks, so convex/crons.ts polls this every five minutes instead.
 * Expected detection delay: up to ~5 minutes for a new booking, cancellation or
 * reschedule to be reflected here. Full design and manual-test instructions:
 * docs/CALENDLY_FREE_SYNC.md
 *
 * CALENDLY_PAT is a Convex environment variable, read only inside this action. It is
 * never returned by any query here, never logged, and this file has no import anywhere
 * near http.ts — nothing in this module is reachable from the browser.
 */

export const TARGET_EVENT_TYPE_NAME = "Real Estate Acquisition System Call";

/**
 * Which Calendly event types this sync watches, one entry per offer.
 *
 * The sync used to resolve exactly ONE event type. That was fine with one funnel; with
 * two it would mean bookings from the second offer are never discovered at all — the
 * API call filters server-side by event_type, so they would not even appear as unmatched.
 *
 * Each offer resolves in this order:
 *   1. its `uriEnv` variable — the API event-type URI. Pins it; immune to renames.
 *   2. its `schedulingUrlEnv` variable — the PUBLIC booking URL, matched against each
 *      event type's `scheduling_url`. This is the value a human actually has to hand,
 *      and unlike a display name it cannot be changed by editing the event's title.
 *   3. its `nameEnv` variable, or `defaultName`, by exact name (case-insensitive)
 *   4. otherwise: not configured
 *
 * A public booking URL is NOT an API event-type URI and cannot be used as one. Step 2
 * exists precisely so nobody has to hand-convert between them or invent a UUID.
 *
 * A `required: false` offer that resolves to nothing is skipped quietly. That is the
 * state before the owner creates the VSL-5 event, and VSL-4 must keep syncing meanwhile.
 * A `required: true` offer that fails is recorded as an error but does NOT abort the run
 * — see resolveTargets.
 */
const EVENT_TYPE_CONFIG = [
  {
    offer: "real_estate_acquisition",
    uriEnv: "CALENDLY_EVENT_TYPE_URI",
    schedulingUrlEnv: "CALENDLY_SCHEDULING_URL",
    nameEnv: "CALENDLY_EVENT_TYPE_NAME",
    defaultName: TARGET_EVENT_TYPE_NAME as string | null,
    required: true,
  },
  {
    offer: "brokerage_content_engine",
    uriEnv: "CALENDLY_CONTENT_EVENT_TYPE_URI",
    schedulingUrlEnv: "CALENDLY_CONTENT_SCHEDULING_URL",
    nameEnv: "CALENDLY_CONTENT_EVENT_TYPE_NAME",
    // No default name on purpose: inventing one would make the run log a scary "not
    // found" error for an event type the owner has not created yet.
    defaultName: null as string | null,
    required: false,
  },
] as const;

type Offer = "real_estate_acquisition" | "brokerage_content_engine";

/**
 * One event type the sync watches, and the offers it can legitimately book for.
 *
 * `offers` is a LIST, not a single value, and it is load-bearing rather than diagnostic.
 * When two offers resolve to the same event type — which is the case today, since both
 * funnels point at one Calendly event — that event genuinely cannot tell them apart, and
 * a booking on it may belong to either. Recording both offers states that ambiguity
 * explicitly instead of silently attributing every booking to whichever offer happened
 * to be listed first.
 *
 * Once the offers have distinct event types, each target carries exactly one offer and a
 * content booking can no longer attach to an acquisition lead that shares an email.
 */
type SyncTarget = {
  offers: Offer[];
  uri: string;
  name?: string;
  source: string;
};

/** Does any offer still need the event-type list fetched? */
export function needsEventTypeLookup(env: Record<string, string | undefined>): boolean {
  return EVENT_TYPE_CONFIG.some((c) => {
    if (env[c.uriEnv]?.trim()) return false; // pinned; no lookup needed
    return Boolean(env[c.schedulingUrlEnv]?.trim() || env[c.nameEnv]?.trim() || c.defaultName);
  });
}

/**
 * Compare booking URLs by origin+path only: trailing slashes, query strings and casing
 * differ harmlessly between what someone pastes and what Calendly returns.
 */
function sameBookingUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const parsed = new URL(u.trim());
      return (parsed.origin + parsed.pathname).replace(/\/+$/, "").toLowerCase();
    } catch {
      return u.trim().replace(/\/+$/, "").toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * Work out which event types to watch, from configuration plus the account's event list.
 *
 * PURE, and exported, for two reasons. The Convex action sandbox blocks outbound requests
 * to loopback addresses, so sync() cannot be driven end-to-end against a mock Calendly
 * (see the note at the top of tools/calendly-sync-test.mjs) — and this is the branchiest
 * logic in the file. Keeping it free of ctx and fetch means tools/calendly-targets-test.mjs
 * can exercise every path, including the failure cases, outside Convex entirely.
 *
 * Failures are RETURNED, never thrown and never fatal. An unresolvable acquisition target
 * must not stop a correctly configured content target from syncing.
 */
export function resolveSyncTargets(
  env: Record<string, string | undefined>,
  eventTypes: { uri: string; name: string; scheduling_url?: string }[],
  userEmail: string,
): { targets: SyncTarget[]; errors: string[] } {
  const targets: SyncTarget[] = [];
  const errors: string[] = [];
  const byUri = new Map<string, SyncTarget>();

  for (const config of EVENT_TYPE_CONFIG) {
    const offer = config.offer as Offer;
    let resolved: Omit<SyncTarget, "offers"> | null = null;
    let failure: string | null = null;

    const pinnedUri = env[config.uriEnv]?.trim();
    const schedulingUrl = env[config.schedulingUrlEnv]?.trim();
    const wantedName = env[config.nameEnv]?.trim() || config.defaultName;

    if (pinnedUri) {
      resolved = { uri: pinnedUri, source: "env" };
    } else if (schedulingUrl) {
      // Resolve the API event-type URI from the PUBLIC booking URL. They are different
      // things and one cannot be substituted for the other, so this does the conversion
      // properly instead of anyone guessing a UUID.
      const match = eventTypes.find(
        (t) => t.scheduling_url && sameBookingUrl(t.scheduling_url, schedulingUrl),
      );
      if (match) {
        resolved = { uri: match.uri, name: match.name, source: "scheduling_url" };
      } else {
        failure = `No Calendly event type with booking URL "${schedulingUrl}" was found for ${userEmail}. Check ${config.schedulingUrlEnv}, or pin ${config.uriEnv} directly.`;
      }
    } else if (wantedName) {
      const match = eventTypes.find(
        (t) => t.name.trim().toLowerCase() === wantedName.toLowerCase(),
      );
      if (match) {
        resolved = { uri: match.uri, name: match.name, source: "name_lookup" };
      } else {
        failure = `No Calendly event type named "${wantedName}" was found for ${userEmail}. Set ${config.uriEnv} or ${config.schedulingUrlEnv} to identify it explicitly.`;
      }
    }
    // else: nothing configured for this offer. Not an error — it has no calendar yet.

    if (!resolved) {
      if (failure) errors.push(failure);
      continue;
    }

    // Two offers may resolve to ONE shared event type. Listing it twice would double
    // every API call in discovery, so merge — and merging the OFFERS rather than keeping
    // the first is what makes the ambiguity explicit downstream: a shared event
    // legitimately serves both, and the lead query is told exactly that.
    const existing = byUri.get(resolved.uri);
    if (existing) {
      if (!existing.offers.includes(offer)) existing.offers.push(offer);
      continue;
    }

    const target: SyncTarget = { ...resolved, offers: [offer] };
    byUri.set(target.uri, target);
    targets.push(target);
  }

  return { targets, errors };
}

const DISCOVERY_WINDOW_PAST_MS = 24 * 60 * 60 * 1000; // 1 day back — catch same-day bookings
const DISCOVERY_WINDOW_FUTURE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days ahead
const RECHECK_PAST_GRACE_MS = 15 * 60 * 1000; // still recheck a meeting up to 15 min after it started
const RECHECK_NAME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // diagnostic name-match lookback
const RECHECK_LIMIT_PER_STATUS = 50; // per run, per status — bounds API calls if the queue is large

/* ══════════════════════════════════════════════════════════════════
   Queries — read-only, called by the action via ctx.runQuery
   ══════════════════════════════════════════════════════════════════ */

/**
 * The most recent unbooked lead with this email, restricted to the offers the booked
 * event type can legitimately serve.
 *
 * The `offers` filter is the whole point. Without it, one person who applies to BOTH
 * funnels with the same address — the owner running an acceptance test, most obviously —
 * can have a content booking attached to their acquisition lead, or the reverse,
 * depending only on which application happened to be submitted last. The booking would
 * then look perfectly healthy while sitting on the wrong row and mirroring to the wrong
 * Sheet line.
 *
 * `offers` is omitted for legacy callers and by the recheck paths, which already know
 * exactly which lead they are looking at.
 */
export const findEligibleLeadByEmail = internalQuery({
  args: {
    normalisedEmail: v.string(),
    offers: v.optional(v.array(offerValidator)),
  },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { normalisedEmail, offers }) => {
    const candidates = await ctx.db
      .query("leads")
      .withIndex("by_normalisedEmail", (q) => q.eq("normalisedEmail", normalisedEmail))
      .order("desc")
      .take(50);
    return (
      candidates.find(
        (l) =>
          (!l.calendlyStatus || l.calendlyStatus === "not_booked") &&
          // offerOf() resolves an absent offer to real_estate_acquisition, so leads
          // written before the field existed are still matchable by the acquisition
          // event type — they are acquisition leads.
          (offers === undefined || offers.includes(offerOf(l))),
      ) ?? null
    );
  },
});

/** Idempotency check: has this Calendly invitee already been matched to a lead? */
export const findLeadByInviteeUri = internalQuery({
  args: { inviteeUri: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { inviteeUri }) =>
    await ctx.db
      .query("leads")
      .withIndex("by_calendlyInviteeUri", (q) => q.eq("calendlyInviteeUri", inviteeUri))
      .first(),
});

/** Idempotency check: has this invitee already been logged as unmatched? */
export const findUnmatchedByInviteeUri = internalQuery({
  args: { inviteeUri: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { inviteeUri }) =>
    await ctx.db
      .query("calendlyUnmatched")
      .withIndex("by_inviteeUri", (q) => q.eq("inviteeUri", inviteeUri))
      .first(),
});

/**
 * Diagnostic only — surfaced on an unmatched row as a hint for a human, never used to
 * auto-link a booking. A same (case-insensitive) name among recent, still-unbooked leads.
 */
export const findCandidateLeadByName = internalQuery({
  args: { name: v.string(), sinceMs: v.number() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { name, sinceMs }) => {
    const recent = await ctx.db
      .query("leads")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", sinceMs))
      .order("desc")
      .take(200);
    const target = name.trim().toLowerCase();
    return (
      recent.find(
        (l) =>
          l.name.trim().toLowerCase() === target &&
          (!l.calendlyStatus || l.calendlyStatus === "not_booked"),
      ) ?? null
    );
  },
});

/** Open bookings due for a cancellation/reschedule recheck, oldest-synced-first. */
export const findLeadsAwaitingRecheck = internalQuery({
  args: { status: calendlyStatusValidator, notBeforeMs: v.number(), limit: v.number() },
  returns: v.array(v.any()),
  handler: async (ctx, { status, notBeforeMs, limit }) => {
    const rows = await ctx.db
      .query("leads")
      .withIndex("by_calendlyStatus", (q) => q.eq("calendlyStatus", status))
      .order("asc") // oldest calendlyLastSyncedAt first — fair rotation across runs
      .take(limit * 4); // over-fetch before the in-JS time filter, still bounded
    return rows.filter((l) => (l.calendlyStartTime ?? 0) > notBeforeMs).slice(0, limit);
  },
});

/**
 * List this account's Calendly event types so the API event-type URI can be read off
 * directly, without anyone pasting, printing or handling CALENDLY_PAT.
 *
 * A public booking URL (calendly.com/you/your-event) is NOT the API event-type URI
 * (api.calendly.com/event_types/UUID) and cannot be substituted for it. This prints the
 * pairing so the correct value can be copied rather than guessed:
 *
 *   npx convex run internal.calendly.listEventTypesForSetup --prod
 *
 * The token is read server-side by calendlyClient and never appears in the output.
 */
export const listEventTypesForSetup = internalAction({
  args: {},
  returns: v.any(),
  handler: async () => {
    if (!process.env.CALENDLY_PAT) {
      return { ok: false, error: "CALENDLY_PAT is not set on this deployment." };
    }
    const me = await getCurrentUser();
    const types = await listEventTypes(me.uri);
    return {
      ok: true,
      user: me.email,
      hint: "Set CALENDLY_CONTENT_EVENT_TYPE_URI to the `apiEventTypeUri` of the content event, " +
            "or set CALENDLY_CONTENT_SCHEDULING_URL to its `publicBookingUrl` and let the sync resolve it.",
      eventTypes: types.map((t) => ({
        name: t.name,
        active: t.active,
        publicBookingUrl: t.scheduling_url ?? null,
        apiEventTypeUri: t.uri,
      })),
    };
  },
});

export const getSyncState = internalQuery({
  args: {},
  returns: v.union(v.any(), v.null()),
  handler: async (ctx) => await ctx.db.query("calendlySyncState").first(),
});

/* ══════════════════════════════════════════════════════════════════
   Mutations — the only code paths that write Calendly fields
   ══════════════════════════════════════════════════════════════════ */

export const markBooked = internalMutation({
  args: {
    leadId: v.id("leads"),
    inviteeUri: v.string(),
    eventUri: v.string(),
    eventTypeUri: v.string(),
    bookedAtMs: v.number(),
    startTimeMs: v.number(),
    endTimeMs: v.number(),
    questionsAndAnswers: v.array(calendlyQAValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Defence in depth: the action already checked findLeadByInviteeUri before calling
    // this, but a mutation that runs twice with the same arguments must still be a no-op.
    const existingEvent = await ctx.db
      .query("bookedCallEvents")
      .withIndex("by_inviteeUri", (q) => q.eq("inviteeUri", args.inviteeUri))
      .first();
    if (existingEvent) return null;

    const lead = await ctx.db.get(args.leadId);
    if (!lead) return null;

    await ctx.db.patch(args.leadId, {
      calendlyStatus: "booked",
      calendlyEventUri: args.eventUri,
      calendlyInviteeUri: args.inviteeUri,
      calendlyEventTypeUri: args.eventTypeUri,
      calendlyBookedAt: args.bookedAtMs,
      calendlyStartTime: args.startTimeMs,
      calendlyEndTime: args.endTimeMs,
      calendlyQuestionsAndAnswers: args.questionsAndAnswers,
      calendlyLastSyncedAt: Date.now(),
      googleSheetsSyncVersion: (lead.googleSheetsSyncVersion ?? 0) + 1,
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });

    // Shaped for a future Google Ads offline/enhanced-conversion upload. Hashed here,
    // once, from the values already on the lead — never re-derived from anything Calendly
    // sent, since Calendly never receives the phone number at all.
    const hashedEmail = await sha256Hex(lead.normalisedEmail);
    const hashedPhone = await sha256Hex(lead.normalisedPhone);

    await ctx.db.insert("bookedCallEvents", {
      inviteeUri: args.inviteeUri,
      leadId: args.leadId,
      submissionId: lead.submissionId,
      gclid: lead.gclid,
      // Additive: Google's cookieless click identifiers, carried through for the same
      // future offline-conversion upload the gclid is here for.
      gbraid: lead.gbraid,
      wbraid: lead.wbraid,
      hashedEmail,
      hashedPhone,
      calendlyBookedAt: args.bookedAtMs,
      createdAt: Date.now(),
    });

    const unmatched = await ctx.db.query("calendlyUnmatched")
      .withIndex("by_inviteeUri", (q) => q.eq("inviteeUri", args.inviteeUri)).first();
    if (unmatched) await ctx.db.patch(unmatched._id, { resolved: true });

    // Booking status is part of the reporting mirror. This queues an async upsert but
    // does not slow the Calendly poll or affect the booking record if Google is down.
    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId: args.leadId });
    return null;
  },
});

export const markCanceled = internalMutation({
  args: { leadId: v.id("leads"), canceledAtMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { leadId, canceledAtMs }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return null;
    // The historical booking record (event/invitee URIs, times) is left in place — a
    // canceled call still happened as an event; only the live status changes. The
    // matching bookedCallEvents row is likewise never deleted or edited.
    await ctx.db.patch(leadId, {
      calendlyStatus: "canceled",
      calendlyCanceledAt: canceledAtMs,
      calendlyLastSyncedAt: Date.now(),
      googleSheetsSyncVersion: (lead.googleSheetsSyncVersion ?? 0) + 1,
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId });
    return null;
  },
});

export const markRescheduled = internalMutation({
  args: {
    leadId: v.id("leads"),
    newInviteeUri: v.string(),
    newEventUri: v.string(),
    newStartTimeMs: v.number(),
    newEndTimeMs: v.number(),
    newQuestionsAndAnswers: v.array(calendlyQAValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const lead = await ctx.db.get(args.leadId);
    if (!lead || lead.calendlyInviteeUri === args.newInviteeUri) return null; // already applied

    // calendlyBookedAt is deliberately untouched: it is the visitor's original booking
    // moment, and a reschedule does not change when they first committed to a call. The
    // event/invitee/time fields move forward to the new slot; calendlyCanceledAt stays
    // unset because the meeting still exists, just at a new time.
    await ctx.db.patch(args.leadId, {
      calendlyStatus: "rescheduled",
      // A permanent flag, unlike calendlyStatus which moves on again if this new booking
      // is later canceled or rescheduled again — lets "canceled after being rescheduled
      // once" be told apart from "canceled outright" without re-deriving it from history.
      calendlyRescheduled: true,
      calendlyEventUri: args.newEventUri,
      calendlyInviteeUri: args.newInviteeUri,
      calendlyStartTime: args.newStartTimeMs,
      calendlyEndTime: args.newEndTimeMs,
      calendlyQuestionsAndAnswers: args.newQuestionsAndAnswers,
      calendlyLastSyncedAt: Date.now(),
      googleSheetsSyncVersion: (lead.googleSheetsSyncVersion ?? 0) + 1,
      googleSheetsSyncStatus: "pending",
      googleSheetsSyncAttempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.sheets.syncLead, { leadId: args.leadId });
    return null;
  },
});

/** Pass B, no-change path: the meeting is still on. Touch so rotation moves forward. */
export const touchSynced = internalMutation({
  args: { leadId: v.id("leads") },
  returns: v.null(),
  handler: async (ctx, { leadId }) => {
    await ctx.db.patch(leadId, { calendlyLastSyncedAt: Date.now() });
    return null;
  },
});

export const recordUnmatched = internalMutation({
  args: {
    inviteeUri: v.string(),
    eventUri: v.string(),
    eventTypeUri: v.string(),
    inviteeEmail: v.string(),
    inviteeName: v.string(),
    startTimeMs: v.number(),
    endTimeMs: v.number(),
    questionsAndAnswers: v.array(calendlyQAValidator),
    diagnosticCandidateLeadId: v.optional(v.id("leads")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("calendlyUnmatched")
      .withIndex("by_inviteeUri", (q) => q.eq("inviteeUri", args.inviteeUri))
      .first();
    if (existing) {
      // Still unresolved on a later run: refresh lastSeenAt and the diagnostic hint, but
      // do not spawn a second row for the same invitee.
      await ctx.db.patch(existing._id, {
        lastSeenAt: Date.now(),
        diagnosticCandidateLeadId: args.diagnosticCandidateLeadId,
      });
      return null;
    }
    // Named explicitly, not spread: the schema's fields are startTime/endTime, the args
    // are startTimeMs/endTimeMs (consistent with every other mutation in this file) — a
    // blind ...args spread would write the wrong field names and miss the right ones.
    await ctx.db.insert("calendlyUnmatched", {
      inviteeUri: args.inviteeUri,
      eventUri: args.eventUri,
      eventTypeUri: args.eventTypeUri,
      inviteeEmail: args.inviteeEmail,
      inviteeName: args.inviteeName,
      startTime: args.startTimeMs,
      endTime: args.endTimeMs,
      questionsAndAnswers: args.questionsAndAnswers,
      diagnosticCandidateLeadId: args.diagnosticCandidateLeadId,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      resolved: false,
    });
    return null;
  },
});

export const setSyncState = internalMutation({
  args: {
    calendlyUserUri: v.optional(v.string()),
    calendlyOrganizationUri: v.optional(v.string()),
    calendlyEventTypeUri: v.optional(v.string()),
    calendlyEventTypeName: v.optional(v.string()),
    calendlyTargets: v.optional(
      v.array(
        v.object({
          // A list: a shared event type legitimately serves more than one offer.
          offers: v.array(offerValidator),
          uri: v.string(),
          name: v.optional(v.string()),
          source: v.string(),
        }),
      ),
    ),
    lastRunOk: v.boolean(),
    lastRunSummary: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("calendlySyncState").first();
    const patch = {
      ...args,
      lastRunAt: Date.now(),
      // Optional arguments are omitted in transport. Explicitly remove an old error
      // after recovery instead of retaining a contradictory red diagnostic forever.
      lastError: args.lastRunOk ? undefined : args.lastError,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("calendlySyncState", patch);
    return null;
  },
});

/* ══════════════════════════════════════════════════════════════════
   The sync action — the only thing crons.ts calls
   ══════════════════════════════════════════════════════════════════ */

export const sync = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!process.env.CALENDLY_PAT) {
      await ctx.runMutation(internal.calendly.setSyncState, {
        lastRunOk: false,
        lastError: "CALENDLY_PAT is not configured; bookings cannot sync.",
      });
      return null;
    }

    try {
      const me = await getCurrentUser();

      /* ── Resolve every configured event type ────────────────────── */
      //
      // Resolution failures are COLLECTED, never fatal. The previous version returned
      // from the whole run the moment the required acquisition target failed to resolve,
      // which meant a pre-existing VSL-4 misconfiguration silently prevented a perfectly
      // healthy VSL-5 target from syncing and stopped the Pass B lifecycle rechecks along
      // with it. One broken calendar must not take down the others.
      let eventTypes: Awaited<ReturnType<typeof listEventTypes>> = [];
      const lookupErrors: string[] = [];
      if (needsEventTypeLookup(process.env)) {
        try { eventTypes = await listEventTypes(me.uri); }
        catch (error) {
          // A list lookup outage must not stop pinned targets or known-booking rechecks.
          lookupErrors.push(`Event-type lookup failed: ${String(error)}`);
        }
      }
      const { targets, errors: resolveErrors } =
        resolveSyncTargets(process.env, eventTypes, me.email);
      const targetErrors: string[] = [...lookupErrors, ...resolveErrors];
      for (const e of resolveErrors) console.error("[calendly] " + e);
      for (const t of targets) {
        if (t.offers.length > 1) {
          console.warn(
            `[calendly] event type ${t.uri} is shared by ${t.offers.join(", ")}. ` +
            `Bookings on it cannot be attributed to one offer by event type alone; ` +
            `matching will accept any of them.`,
          );
        }
      }

      if (targets.length === 0) {
        const msg = targetErrors.length
          ? `No Calendly event type could be resolved. ${targetErrors.join(" | ")}`
          : "No Calendly event types are configured for any offer.";
        console.error("[calendly] " + msg);
        // Pass B still runs below: rechecks work from invitee URIs already stored on
        // leads and need no event type at all. Cancellations and reschedules must keep
        // being detected even while discovery is misconfigured.
      }

      /* ── Pass A: discover new bookings, across every target ──────── */
      const now = Date.now();
      const events: {
        uri: string; start_time: string; end_time: string;
        eventTypeUri: string; offers: Offer[];
      }[] = [];
      for (const target of targets) {
        try {
          const found = await listActiveEvents(
            me.uri,
            target.uri,
            new Date(now - DISCOVERY_WINDOW_PAST_MS),
            new Date(now + DISCOVERY_WINDOW_FUTURE_MS),
          );
          for (const e of found) {
            events.push({ ...e, eventTypeUri: target.uri, offers: target.offers });
          }
        } catch (e) {
          // One unreachable or unauthorised event type must not cost us the others.
          const msg = `Listing events for ${target.uri} failed: ${String(e)}`;
          console.error("[calendly] " + msg);
          targetErrors.push(msg);
        }
      }

      let discovered = 0,
        booked = 0,
        unmatched = 0,
        errors = 0;

      for (const event of events) {
        try {
          const invitees = await listInvitees(event.uri);
          for (const invitee of invitees) {
            // Cancellations on events we haven't matched to a lead are not this pass's
            // concern — Pass B handles cancellation only for bookings we already know
            // about. An unmatched cancellation has nothing to update.
            if (invitee.status !== "active") continue;

            const alreadyBooked = await ctx.runQuery(internal.calendly.findLeadByInviteeUri, {
              inviteeUri: invitee.uri,
            });
            if (alreadyBooked) continue;
            // A rescheduled invitee belongs to the original lead. Defer to Pass B,
            // even if the person has since submitted another application with this email.
            let ancestorUri = invitee.old_invitee;
            let belongsToExistingLead = false;
            const ancestors = new Set<string>();
            while (ancestorUri) {
              if (ancestors.has(ancestorUri) || ancestors.size >= 10) {
                throw new Error("Invalid or excessive Calendly reschedule chain");
              }
              ancestors.add(ancestorUri);
              const originalLead = await ctx.runQuery(internal.calendly.findLeadByInviteeUri, {
                inviteeUri: ancestorUri,
              });
              if (originalLead) { belongsToExistingLead = true; break; }
              ancestorUri = (await getInvitee(ancestorUri)).old_invitee;
            }
            if (belongsToExistingLead) continue;
            // Retry previously unmatched invitees: a lead or corrected email can arrive
            // after the first poll. recordUnmatched already upserts without duplicates.

            discovered++;
            const normalisedEmail = invitee.email.trim().toLowerCase();
            const lead = await ctx.runQuery(internal.calendly.findEligibleLeadByEmail, {
              normalisedEmail,
              // Only the offers this event type can legitimately book for. With
              // distinct event types, a content booking can no longer land on an
              // acquisition lead that happens to share the email.
              offers: event.offers,
            });

            if (lead) {
              await ctx.runMutation(internal.calendly.markBooked, {
                leadId: lead._id,
                inviteeUri: invitee.uri,
                eventUri: event.uri,
                eventTypeUri: event.eventTypeUri,
                bookedAtMs: Date.parse(invitee.created_at),
                startTimeMs: Date.parse(event.start_time),
                endTimeMs: Date.parse(event.end_time),
                questionsAndAnswers: invitee.questions_and_answers ?? [],
              });
              booked++;
            } else {
              const candidate = await ctx.runQuery(internal.calendly.findCandidateLeadByName, {
                name: invitee.name,
                sinceMs: now - RECHECK_NAME_WINDOW_MS,
              });
              await ctx.runMutation(internal.calendly.recordUnmatched, {
                inviteeUri: invitee.uri,
                eventUri: event.uri,
                eventTypeUri: event.eventTypeUri,
                inviteeEmail: normalisedEmail,
                inviteeName: invitee.name,
                startTimeMs: Date.parse(event.start_time),
                endTimeMs: Date.parse(event.end_time),
                questionsAndAnswers: invitee.questions_and_answers ?? [],
                diagnosticCandidateLeadId: candidate ? candidate._id : undefined,
              });
              unmatched++;
            }
          }
        } catch (e) {
          errors++;
          console.error(`[calendly] failed processing event ${event.uri}: ${String(e)}`);
        }
      }

      /* ── Pass B: recheck open bookings for cancellation/reschedule ─ */
      let rechecked = 0,
        canceled = 0,
        rescheduled = 0;
      const notBeforeMs = now - RECHECK_PAST_GRACE_MS;

      for (const status of ["booked", "rescheduled"] as const) {
        const pending = await ctx.runQuery(internal.calendly.findLeadsAwaitingRecheck, {
          status,
          notBeforeMs,
          limit: RECHECK_LIMIT_PER_STATUS,
        });
        for (const lead of pending) {
          if (!lead.calendlyInviteeUri) continue;
          rechecked++;
          try {
            const invitee = await getInvitee(lead.calendlyInviteeUri);
            if (invitee.status === "active") {
              await ctx.runMutation(internal.calendly.touchSynced, { leadId: lead._id });
              continue;
            }
            if (invitee.rescheduled && invitee.new_invitee) {
              let newInvitee = await getInvitee(invitee.new_invitee);
              const seen = new Set<string>([invitee.uri]);
              while (newInvitee.status === "canceled" && newInvitee.rescheduled && newInvitee.new_invitee) {
                if (seen.has(newInvitee.uri) || seen.size >= 10) {
                  throw new Error("Invalid or excessive Calendly reschedule chain");
                }
                seen.add(newInvitee.uri);
                newInvitee = await getInvitee(newInvitee.new_invitee);
              }
              const newEvent = await getEvent(newInvitee.event);
              await ctx.runMutation(internal.calendly.markRescheduled, {
                leadId: lead._id,
                newInviteeUri: newInvitee.uri,
                newEventUri: newEvent.uri,
                newStartTimeMs: Date.parse(newEvent.start_time),
                newEndTimeMs: Date.parse(newEvent.end_time),
                newQuestionsAndAnswers: newInvitee.questions_and_answers ?? [],
              });
              rescheduled++;
              if (newInvitee.status === "canceled") {
                await ctx.runMutation(internal.calendly.markCanceled, {
                  leadId: lead._id,
                  canceledAtMs: newInvitee.cancellation?.canceled_at
                    ? Date.parse(newInvitee.cancellation.canceled_at) : Date.now(),
                });
                canceled++;
              }
            } else {
              await ctx.runMutation(internal.calendly.markCanceled, {
                leadId: lead._id,
                canceledAtMs: invitee.cancellation?.canceled_at
                  ? Date.parse(invitee.cancellation.canceled_at)
                  : Date.now(),
              });
              canceled++;
            }
          } catch (e) {
            errors++;
            console.error(`[calendly] recheck failed for lead ${lead._id}: ${String(e)}`);
          }
        }
      }

      const acquisitionTarget = targets.find((t) =>
        t.offers.includes("real_estate_acquisition"));
      const summary =
        `targets=${targets.length} events=${events.length} discovered=${discovered} booked=${booked} ` +
        `unmatched=${unmatched} rechecked=${rechecked} canceled=${canceled} ` +
        `rescheduled=${rescheduled} errors=${errors} targetErrors=${targetErrors.length}`;
      console.log("[calendly] " + summary);
      await ctx.runMutation(internal.calendly.setSyncState, {
        calendlyUserUri: me.uri,
        calendlyOrganizationUri: me.current_organization,
        // The acquisition target keeps the two original singular fields so existing
        // docs, dashboards and `getSyncState` readers keep working unchanged.
        calendlyEventTypeUri: acquisitionTarget?.uri,
        calendlyEventTypeName: acquisitionTarget?.name,
        calendlyTargets: targets,
        // A resolution failure on ONE offer is reported without claiming the whole run
        // failed — the healthy targets really did sync, and saying otherwise would hide
        // that fact behind an unrelated misconfiguration.
        lastRunOk: targetErrors.length === 0 && errors === 0,
        lastRunSummary: summary,
        lastError: [...targetErrors, ...(errors ? [`${errors} booking processing/recheck errors; inspect sync logs.`] : [])]
          .join(" | ").slice(0, 1000) || undefined,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[calendly] sync run failed: " + message);
      // Best-effort — must not let the error-reporting write itself throw uncaught.
      await ctx.runMutation(internal.calendly.setSyncState, {
        lastRunOk: false,
        lastError: message,
      }).catch(() => {});
    }
    return null;
  },
});

/* ══════════════════════════════════════════════════════════════════
   Debug/operational helpers — internal only, mirror convex/admin.ts
   ══════════════════════════════════════════════════════════════════ */

export const debugCountUnmatched = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("calendlyUnmatched").collect()).length,
});

export const debugListUnmatched = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, { limit }) =>
    await ctx.db.query("calendlyUnmatched").order("desc").take(limit ?? 20),
});

export const debugCountBookedCallEvents = internalQuery({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("bookedCallEvents").collect()).length,
});

export const debugListBookedCallEvents = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.any()),
  handler: async (ctx, { limit }) =>
    await ctx.db.query("bookedCallEvents").order("desc").take(limit ?? 20),
});

/** Wipes both new tables. Never touches leads. Used to reset between test runs. */
export const debugPurgeAll = internalMutation({
  args: {},
  returns: v.object({ unmatched: v.number(), bookedCallEvents: v.number() }),
  handler: async (ctx) => {
    const unmatched = await ctx.db.query("calendlyUnmatched").collect();
    for (const row of unmatched) await ctx.db.delete(row._id);
    const events = await ctx.db.query("bookedCallEvents").collect();
    for (const row of events) await ctx.db.delete(row._id);
    const state = await ctx.db.query("calendlySyncState").first();
    if (state) await ctx.db.delete(state._id);
    return { unmatched: unmatched.length, bookedCallEvents: events.length };
  },
});
