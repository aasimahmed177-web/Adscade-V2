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
  args: { limit: v.optional(v.number()), offer: v.optional(offerValidator) },
  returns: v.array(v.any()),
  handler: async (ctx, { limit, offer }) => {
    const rows = await ctx.db
      .query("leads")
      .withIndex("by_createdAt")
      .order("desc")
      .take(offer === undefined ? (limit ?? 20) : (limit ?? 20) * 5);
    // Filtered in JS rather than through by_offer_createdAt because rows written before
    // the offer field existed have no value to index on, and those ARE acquisition rows.
    return offer === undefined
      ? rows
      : rows.filter((l) => offerOf(l) === offer).slice(0, limit ?? 20);
  },
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
      // Rows from offers that ask no budget question have no value to migrate.
      if (lead.monthlyMediaBudget === undefined) continue;
      const replacement = map[lead.monthlyMediaBudget];
      if (!replacement) continue;
      await ctx.db.patch(lead._id, {
        monthlyMediaBudget: replacement,
        googleSheetsSyncVersion: (lead.googleSheetsSyncVersion ?? 0) + 1,
        googleSheetsSyncStatus: "pending",
        googleSheetsSyncAttempts: 0,
      });
      await ctx.scheduler.runAfter(updated * 750, internal.sheets.syncLead, { leadId: lead._id });
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
    notApplicable: v.number(),
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
    let notApplicable = 0;
    for (const lead of all) {
      // Offers that ask no budget question are counted separately. Without this they
      // fall through to `unexpected` and make a healthy migration look broken — every
      // brokerage_content_engine row would be reported as an unrecognised budget key.
      if (lead.monthlyMediaBudget === undefined) notApplicable += 1;
      else if (legacy.has(lead.monthlyMediaBudget)) legacyCount += 1;
      else if (canonical.has(lead.monthlyMediaBudget)) canonicalCount += 1;
      else unexpected += 1;
    }

    return {
      total: all.length,
      legacy: legacyCount,
      canonical: canonicalCount,
      unexpected,
      notApplicable,
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

/* ══════════════════════════════════════════════════════════════════
   Funnel telemetry diagnostics (anonymous — see convex/funnel.ts)
   ══════════════════════════════════════════════════════════════════ */

import { FUNNEL_EVENT_NAMES, offerOf, offerValidator } from "./schema";

/**
 * Stage-to-stage funnel over a lookback window.
 *
 * Rates are computed from UNIQUE SESSIONS, not raw rows. Raw counts overstate every
 * stage where one visitor can act twice — `initial_cta_click` in particular is not a
 * once-per-session event, so a visitor who taps two CTAs before filling the form would
 * otherwise inflate the CTA stage and make the funnel look wrong. Raw counts are still
 * reported alongside, because a large gap between the two is itself informative.
 *
 *   npx convex run admin:funnelSummary '{"hours":72}'
 *   npx convex run admin:funnelSummary '{"hours":72,"utmCampaign":"dg_inm_others_uae_camp"}'
 */
export const funnelSummary = internalQuery({
  args: {
    hours: v.optional(v.number()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    // Omit to see every funnel at once; pass one to read a single offer's ladder.
    offer: v.optional(offerValidator),
  },
  returns: v.any(),
  handler: async (ctx, { hours, utmCampaign, utmContent, offer }) => {
    const windowHours = hours ?? 24;
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    let rows = await ctx.db
      .query("funnelEvents")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .collect();

    if (utmCampaign !== undefined) rows = rows.filter((r) => r.utmCampaign === utmCampaign);
    if (utmContent !== undefined) rows = rows.filter((r) => r.utmContent === utmContent);
    // offerOf() maps an absent offer to real_estate_acquisition, so filtering by that
    // offer correctly includes every event recorded before VSL-5 existed.
    if (offer !== undefined) rows = rows.filter((r) => offerOf(r) === offer);

    const rawCounts: Record<string, number> = {};
    const sessionSets: Record<string, Set<string>> = {};
    for (const name of FUNNEL_EVENT_NAMES) {
      rawCounts[name] = 0;
      sessionSets[name] = new Set();
    }
    for (const row of rows) {
      rawCounts[row.eventName] += 1;
      sessionSets[row.eventName].add(row.sessionId);
    }

    const uniqueSessions: Record<string, number> = {};
    for (const name of FUNNEL_EVENT_NAMES) uniqueSessions[name] = sessionSets[name].size;

    // Percentage of `from` sessions that also reached `to`. Null when `from` is empty —
    // reporting 0% for a stage nobody reached would read as a broken funnel.
    const pct = (from: string, to: string): number | null => {
      const a = uniqueSessions[from];
      if (a === 0) return null;
      const reached = [...sessionSets[from]].filter((id) => sessionSets[to].has(id)).length;
      return Math.round((reached / a) * 1000) / 10;
    };

    const conversion: Record<string, number | null> = {
      "landing -> CTA": pct("landing_page_view", "initial_cta_click"),
      "CTA -> modal": pct("initial_cta_click", "lead_modal_open"),
      "modal -> form start": pct("lead_modal_open", "lead_form_start"),
      "form start -> submit": pct("lead_form_start", "lead_form_submit"),
      "submit -> stored": pct("lead_form_submit", "lead_form_stored"),
    };

    // Qualification is a reporting segment, not a booking gate. Content traffic with
    // zero qualified sessions should show 0%; acquisition has no such classification.
    const hasQualificationStage = offer === "brokerage_content_engine" ||
      rows.some((row) => offerOf(row) === "brokerage_content_engine");
    if (hasQualificationStage) {
      conversion["stored -> qualified"] = pct("lead_form_stored", "lead_qualified");
      conversion["qualified -> Calendly redirect"] = pct("lead_qualified", "calendly_redirect");
    }
    conversion["stored -> Calendly redirect"] = pct("lead_form_stored", "calendly_redirect");
    conversion["landing -> stored lead"] = pct("landing_page_view", "lead_form_stored");

    return {
      windowHours,
      filters: {
        utmCampaign: utmCampaign ?? null,
        utmContent: utmContent ?? null,
        offer: offer ?? null,
      },
      totalEvents: rows.length,
      totalSessions: new Set(rows.map((r) => r.sessionId)).size,
      // Which offers actually appear in this window — a quick check that a newly
      // deployed page is really reporting before you go looking for its numbers.
      offersSeen: [...new Set(rows.map((r) => offerOf(r)))].sort(),
      rawCounts,
      uniqueSessions,
      conversion,
    };
  },
});

/**
 * The same unique-session funnel, grouped so UAE vs Gulf campaigns and individual
 * creatives can be compared directly.
 *
 *   npx convex run admin:funnelBreakdown '{"hours":72,"groupBy":"utmContent"}'
 */
export const funnelBreakdown = internalQuery({
  args: {
    hours: v.optional(v.number()),
    groupBy: v.optional(v.union(
      v.literal("utmCampaign"),
      v.literal("utmContent"),
      v.literal("device"),
      v.literal("offer"),
    )),
    offer: v.optional(offerValidator),
  },
  returns: v.any(),
  handler: async (ctx, { hours, groupBy, offer }) => {
    const windowHours = hours ?? 24;
    const key = groupBy ?? "utmCampaign";
    const since = Date.now() - windowHours * 60 * 60 * 1000;

    let rows = await ctx.db
      .query("funnelEvents")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .collect();

    if (offer !== undefined) rows = rows.filter((r) => offerOf(r) === offer);

    const groups = new Map<string, Record<string, Set<string>>>();
    for (const row of rows) {
      const g =
        key === "utmCampaign" ? (row.utmCampaign ?? "(none)")
        : key === "utmContent" ? (row.utmContent ?? "(none)")
        : key === "offer" ? offerOf(row)
        : (row.deviceCategory ?? "(none)");

      let bucket = groups.get(g);
      if (!bucket) {
        bucket = {};
        for (const name of FUNNEL_EVENT_NAMES) bucket[name] = new Set();
        groups.set(g, bucket);
      }
      bucket[row.eventName].add(row.sessionId);
    }

    const out = [...groups.entries()]
      .map(([group, bucket]) => {
        const sessions: Record<string, number> = {};
        for (const name of FUNNEL_EVENT_NAMES) sessions[name] = bucket[name].size;
        const views = sessions.landing_page_view;
        const storedAfterView = [...bucket.landing_page_view]
          .filter((id) => bucket.lead_form_stored.has(id)).length;
        return {
          group,
          uniqueSessions: sessions,
          landingToStoredPct:
            views === 0 ? null : Math.round((storedAfterView / views) * 1000) / 10,
        };
      })
      // Busiest first: the campaign with the most landing views is the one worth reading.
      .sort((a, b) => b.uniqueSessions.landing_page_view - a.uniqueSessions.landing_page_view);

    return { windowHours, groupBy: key, filters: { offer: offer ?? null }, groups: out };
  },
});
