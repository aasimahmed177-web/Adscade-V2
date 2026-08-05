import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { calendlyQAValidator, calendlyStatusValidator } from "./schema";
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

const DISCOVERY_WINDOW_PAST_MS = 24 * 60 * 60 * 1000; // 1 day back — catch same-day bookings
const DISCOVERY_WINDOW_FUTURE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days ahead
const RECHECK_PAST_GRACE_MS = 15 * 60 * 1000; // still recheck a meeting up to 15 min after it started
const RECHECK_NAME_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // diagnostic name-match lookback
const RECHECK_LIMIT_PER_STATUS = 50; // per run, per status — bounds API calls if the queue is large

/* ══════════════════════════════════════════════════════════════════
   Queries — read-only, called by the action via ctx.runQuery
   ══════════════════════════════════════════════════════════════════ */

/** The most recent lead with this email that has not already been matched to a booking. */
export const findEligibleLeadByEmail = internalQuery({
  args: { normalisedEmail: v.string() },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { normalisedEmail }) => {
    const candidates = await ctx.db
      .query("leads")
      .withIndex("by_normalisedEmail", (q) => q.eq("normalisedEmail", normalisedEmail))
      .order("desc")
      .take(50);
    return candidates.find((l) => !l.calendlyStatus || l.calendlyStatus === "not_booked") ?? null;
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
      hashedEmail,
      hashedPhone,
      calendlyBookedAt: args.bookedAtMs,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const markCanceled = internalMutation({
  args: { leadId: v.id("leads"), canceledAtMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { leadId, canceledAtMs }) => {
    // The historical booking record (event/invitee URIs, times) is left in place — a
    // canceled call still happened as an event; only the live status changes. The
    // matching bookedCallEvents row is likewise never deleted or edited.
    await ctx.db.patch(leadId, {
      calendlyStatus: "canceled",
      calendlyCanceledAt: canceledAtMs,
      calendlyLastSyncedAt: Date.now(),
    });
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
    });
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
    lastRunOk: v.boolean(),
    lastRunSummary: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("calendlySyncState").first();
    const patch = { ...args, lastRunAt: Date.now() };
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
      // Not an error: this is the expected state before the owner configures the token.
      // Logging a warning (not throwing) keeps the Convex Health dashboard quiet rather
      // than showing a failed action every five minutes pre-launch.
      console.warn("[calendly] CALENDLY_PAT is not set — skipping this run.");
      return null;
    }

    try {
      const me = await getCurrentUser();

      const pinnedEventTypeUri = process.env.CALENDLY_EVENT_TYPE_URI;
      let eventType: { uri: string; name: string };
      if (pinnedEventTypeUri) {
        eventType = { uri: pinnedEventTypeUri, name: TARGET_EVENT_TYPE_NAME };
      } else {
        const types = await listEventTypes(me.uri);
        const match = types.find(
          (t) => t.name.trim().toLowerCase() === TARGET_EVENT_TYPE_NAME.toLowerCase(),
        );
        if (!match) {
          const msg = `No Calendly event type named "${TARGET_EVENT_TYPE_NAME}" was found for ${me.email}. Set CALENDLY_EVENT_TYPE_URI to pin it explicitly.`;
          console.error("[calendly] " + msg);
          await ctx.runMutation(internal.calendly.setSyncState, {
            calendlyUserUri: me.uri,
            calendlyOrganizationUri: me.organization,
            lastRunOk: false,
            lastError: msg,
          });
          return null;
        }
        eventType = match;
      }

      /* ── Pass A: discover new bookings ──────────────────────────── */
      const now = Date.now();
      const events = await listActiveEvents(
        me.uri,
        eventType.uri,
        new Date(now - DISCOVERY_WINDOW_PAST_MS),
        new Date(now + DISCOVERY_WINDOW_FUTURE_MS),
      );

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
            const alreadyLogged = await ctx.runQuery(internal.calendly.findUnmatchedByInviteeUri, {
              inviteeUri: invitee.uri,
            });
            if (alreadyLogged) continue;

            discovered++;
            const normalisedEmail = invitee.email.trim().toLowerCase();
            const lead = await ctx.runQuery(internal.calendly.findEligibleLeadByEmail, {
              normalisedEmail,
            });

            if (lead) {
              await ctx.runMutation(internal.calendly.markBooked, {
                leadId: lead._id,
                inviteeUri: invitee.uri,
                eventUri: event.uri,
                eventTypeUri: eventType.uri,
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
                eventTypeUri: eventType.uri,
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
              const newInvitee = await getInvitee(invitee.new_invitee);
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

      const summary =
        `events=${events.length} discovered=${discovered} booked=${booked} ` +
        `unmatched=${unmatched} rechecked=${rechecked} canceled=${canceled} ` +
        `rescheduled=${rescheduled} errors=${errors}`;
      console.log("[calendly] " + summary);
      await ctx.runMutation(internal.calendly.setSyncState, {
        calendlyUserUri: me.uri,
        calendlyOrganizationUri: me.organization,
        calendlyEventTypeUri: eventType.uri,
        calendlyEventTypeName: eventType.name,
        lastRunOk: true,
        lastRunSummary: summary,
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
