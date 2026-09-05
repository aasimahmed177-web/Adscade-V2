import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { offerOf } from "./schema";

/**
 * Google Sheets is a reporting mirror, never the source of truth.
 *
 * Flow:
 *   lead mutation commits in Convex -> schedules syncLead -> Apps Script upserts by submissionId.
 *   Calendly booking/cancel/reschedule mutations schedule the same syncLead action again.
 *
 * Nothing in the browser waits for Google Sheets. Convex remains authoritative and the
 * visitor can be redirected to Calendly as soon as /submit-lead returns stored:true.
 */

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [
  60_000,            // 1 minute
  5 * 60_000,        // 5 minutes
  30 * 60_000,       // 30 minutes
  2 * 60 * 60_000,   // 2 hours
  12 * 60 * 60_000,  // 12 hours
];

function iso(ms?: number): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms)
    ? new Date(ms).toISOString()
    : undefined;
}

function errText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 500);
}

/**
 * Label helpers take `string | undefined` because a brokerage_content_engine row has no
 * inventory or budget answer, and an acquisition row has no team-size answer. An absent
 * answer becomes an empty cell, never the string "undefined".
 */
function inventoryLabel(value?: string): string {
  if (!value) return "";
  return ({
    "1_19": "1–19",
    "20_49": "20–49",
    "50_99": "50–99",
    "100_plus": "100+",
  } as Record<string, string>)[value] ?? value;
}

function teamSizeLabel(value?: string): string {
  if (!value) return "";
  return ({
    "1_4": "1–4 people",
    "5_9": "5–9 people",
    "10_19": "10–19 people",
    "20_plus": "20+ people",
  } as Record<string, string>)[value] ?? value;
}

function mediaBudgetLabel(value?: string): string {
  if (!value) return "";
  return ({
    "below_aed_5000": "Below AED 5,000",
    "aed_5000_15000": "AED 5,000–15,000",
    "aed_15000_30000": "AED 15,000–30,000",
    "above_aed_30000": "Above AED 30,000",
    // Defensive legacy mapping while cached pages age out.
    "below_1l": "Below AED 5,000",
    "1_3l": "AED 5,000–15,000",
    "3_5l": "AED 15,000–30,000",
    "above_5l": "Above AED 30,000",
  } as Record<string, string>)[value] ?? value;
}

export const getLeadForSync = internalQuery({
  args: { leadId: v.id("leads") },
  returns: v.union(v.any(), v.null()),
  handler: async (ctx, { leadId }) => await ctx.db.get(leadId),
});

export const markSuccess = internalMutation({
  args: { leadId: v.id("leads") },
  returns: v.null(),
  handler: async (ctx, { leadId }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return null;
    await ctx.db.patch(leadId, {
      googleSheetsSyncStatus: "synced",
      googleSheetsLastSyncedAt: Date.now(),
      googleSheetsLastError: undefined,
    });
    return null;
  },
});

export const recordFailure = internalMutation({
  args: { leadId: v.id("leads"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { leadId, error }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return null;

    const attempts = (lead.googleSheetsSyncAttempts ?? 0) + 1;
    const retry = attempts < MAX_ATTEMPTS;

    await ctx.db.patch(leadId, {
      googleSheetsSyncStatus: retry ? "pending" : "failed",
      googleSheetsSyncAttempts: attempts,
      googleSheetsLastError: error.slice(0, 500),
    });

    if (retry) {
      const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      await ctx.scheduler.runAfter(delay, internal.sheets.syncLead, { leadId });
    }
    return null;
  },
});

/**
 * Re-queue any lead that is not currently marked synced. This is a backstop for transient
 * outages or a temporarily missing Apps Script configuration. The hourly cron calls it.
 */
export const reconcileUnsynced = internalMutation({
  args: {},
  returns: v.object({ queued: v.number(), scanned: v.number() }),
  handler: async (ctx) => {
    const all = await ctx.db.query("leads").collect();
    const unsynced = all.filter((lead) => lead.googleSheetsSyncStatus !== "synced").slice(0, 100);

    for (let i = 0; i < unsynced.length; i += 1) {
      const lead = unsynced[i];
      await ctx.db.patch(lead._id, {
        googleSheetsSyncStatus: "pending",
        googleSheetsSyncAttempts: 0,
      });
      // Stagger to avoid a burst against Apps Script's single-script lock.
      await ctx.scheduler.runAfter(i * 750, internal.sheets.syncLead, { leadId: lead._id });
    }

    return { queued: unsynced.length, scanned: all.length };
  },
});

export const syncLead = internalAction({
  args: { leadId: v.id("leads") },
  returns: v.null(),
  handler: async (ctx, { leadId }) => {
    const webhook = process.env.GOOGLE_SHEETS_WEBHOOK_URL?.trim();
    if (!webhook) {
      await ctx.runMutation(internal.sheets.recordFailure, {
        leadId,
        error: "GOOGLE_SHEETS_WEBHOOK_URL is not configured",
      });
      return null;
    }

    const lead = await ctx.runQuery(internal.sheets.getLeadForSync, { leadId });
    if (!lead) return null;

    const bookingStatus = lead.calendlyStatus ?? "not_booked";
    const payload = {
      sync_secret: process.env.GOOGLE_SHEETS_SYNC_SECRET ?? "",
      source: "convex_mirror",
      convex_id: String(lead._id),
      submission_id: lead.submissionId,
      lead_timestamp: iso(lead.createdAt),
      // One sheet, one row per submissionId, every offer. `offer` is the column that
      // separates them — filter or pivot on it rather than routing to another tab, so
      // the booking-status mirror below stays a single code path for all offers.
      offer: offerOf(lead),
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      // Acquisition answers. Empty on a content row.
      active_inventory: lead.activeInventory ?? "",
      monthly_media_budget: lead.monthlyMediaBudget ?? "",
      active_inventory_label: inventoryLabel(lead.activeInventory),
      monthly_media_budget_label: mediaBudgetLabel(lead.monthlyMediaBudget),
      // Content answers. Empty on an acquisition row.
      company_name: lead.companyName ?? "",
      team_size: lead.teamSize ?? "",
      team_size_label: teamSizeLabel(lead.teamSize),
      monthly_shoot: lead.monthlyShoot ?? "",
      // The server's verdict, mirrored so the Sheet shows what the visitor was actually
      // shown. Empty (not "false") on offers that have no qualification gate at all.
      content_qualified:
        typeof lead.contentQualified === "boolean" ? lead.contentQualified : "",
      device: lead.deviceCategory ?? "",
      landing_page: lead.landingPage ?? "",
      referrer: lead.referrer ?? "",
      utm_source: lead.utmSource ?? "",
      utm_medium: lead.utmMedium ?? "",
      utm_campaign: lead.utmCampaign ?? "",
      utm_content: lead.utmContent ?? "",
      utm_term: lead.utmTerm ?? "",
      gclid: lead.gclid ?? "",
      // The Apps Script receiver has always had gbraid/wbraid columns, but Convex never
      // sent them, so those two columns were permanently blank. Now populated.
      gbraid: lead.gbraid ?? "",
      wbraid: lead.wbraid ?? "",
      consent: lead.consent,
      lead_status: lead.status,
      calendly_status: bookingStatus,
      booked_once: Boolean(lead.calendlyBookedAt),
      calendly_booked_at: iso(lead.calendlyBookedAt) ?? "",
      calendly_start_time: iso(lead.calendlyStartTime) ?? "",
      calendly_end_time: iso(lead.calendlyEndTime) ?? "",
      calendly_canceled_at: iso(lead.calendlyCanceledAt) ?? "",
      calendly_rescheduled: Boolean(lead.calendlyRescheduled),
      calendly_event_uri: lead.calendlyEventUri ?? "",
      calendly_invitee_uri: lead.calendlyInviteeUri ?? "",
      calendly_event_type_uri: lead.calendlyEventTypeUri ?? "",
      calendly_questions_and_answers: JSON.stringify(lead.calendlyQuestionsAndAnswers ?? []),
      calendly_last_synced_at: iso(lead.calendlyLastSyncedAt) ?? "",
      convex_status: "stored",
      convex_updated_at: new Date().toISOString(),
    };

    try {
      const response = await fetch(webhook, {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const raw = await response.text();
      let parsed: { ok?: boolean; stored?: boolean; error?: string } = {};
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        // Keep parsed empty; the error below includes the HTTP status and short body.
      }

      if (!response.ok || parsed.ok !== true || parsed.stored !== true) {
        throw new Error(
          `Sheets mirror rejected: HTTP ${response.status}; ${parsed.error ?? raw.slice(0, 180)}`,
        );
      }

      await ctx.runMutation(internal.sheets.markSuccess, { leadId });
    } catch (error) {
      await ctx.runMutation(internal.sheets.recordFailure, {
        leadId,
        error: errText(error),
      });
    }

    return null;
  },
});
