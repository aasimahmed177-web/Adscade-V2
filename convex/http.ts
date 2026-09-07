import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  ACCEPTED_MEDIA_BUDGET,
  ACTIVE_INVENTORY,
  FUNNEL_EVENT_NAMES,
  MONTHLY_SHOOT,
  OFFERS,
  TEAM_SIZE,
} from "./schema";

/**
 * Public intake endpoint for the /vsl-4/ landing page.
 *
 * CORS is NOT authentication. An allow-list stops an ordinary browser on another site
 * from posting here; it stops nothing that can set its own headers (curl, a script, a
 * server). The real protections are validation, the enum checks, length caps, the
 * honeypot and idempotency — all below.
 */

const PRODUCTION_ORIGINS = ["https://adscade.com", "https://www.adscade.com"];

/**
 * Production allows exactly the two Adscade origins.
 *
 * ADSCADE_DEV_ORIGIN is an optional Convex environment variable used ONLY on the dev
 * deployment, so an end-to-end browser test can run against a real backend instead of a
 * stub. It is deliberately not set in production — verify with:
 *   npx convex env list --prod
 */
function allowedOrigins(): Set<string> {
  const extra = process.env.ADSCADE_DEV_ORIGIN;
  return new Set(extra ? [...PRODUCTION_ORIGINS, extra] : PRODUCTION_ORIGINS);
}

type CanonicalMediaBudget =
  | "below_aed_5000"
  | "aed_5000_15000"
  | "aed_15000_30000"
  | "above_aed_30000";

/**
 * Accept the four legacy India-era keys for stale/cached landing pages, but always write
 * the Dubai/AED-native value to Convex. This makes the database readable without making
 * an older visitor fail at checkout.
 */
function normaliseMediaBudget(value: unknown): CanonicalMediaBudget | null {
  if (typeof value !== "string" ||
      !(ACCEPTED_MEDIA_BUDGET as readonly string[]).includes(value)) {
    return null;
  }

  const map: Record<string, CanonicalMediaBudget> = {
    below_1l: "below_aed_5000",
    "1_3l": "aed_5000_15000",
    "3_5l": "aed_15000_30000",
    above_5l: "above_aed_30000",
    below_aed_5000: "below_aed_5000",
    aed_5000_15000: "aed_5000_15000",
    aed_15000_30000: "aed_15000_30000",
    above_aed_30000: "above_aed_30000",
  };

  return map[value] ?? null;
}

const MAX_BODY_BYTES = 8 * 1024; // the whole payload is a few hundred bytes
const MAX = {
  name: 200,
  companyName: 200,
  email: 254,
  phone: 32,
  submissionId: 64,
  url: 2048,
  utm: 256,
  userAgent: 512,
} as const;

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Caches must not serve one origin's CORS response to another.
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  // Echo the *matched* allow-listed origin, never the received one, and never "*".
  if (origin !== null && allowedOrigins().has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
}

/**
 * Neutralise spreadsheet formulas. The leads table gets exported to CSV and opened in
 * Excel or Sheets — that is how a sales team works a list. A cell beginning = + - @ or a
 * control character is executed on open, so `=HYPERLINK(...)` can exfiltrate neighbouring
 * cells and `=cmd|...` is a live DDE payload. Prefixing an apostrophe is the standard
 * neutralisation and is invisible once imported.
 */
function deformula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/** An http(s) URL, or undefined. Blocks javascript: and data: reaching an operator view. */
function safeUrl(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return trimmed.slice(0, max);
  } catch {
    return undefined;
  }
}

/** deformula for optional values. */
function deformulaOpt(value: string | undefined): string | undefined {
  return value === undefined ? undefined : deformula(value);
}

/** Trimmed string of bounded length, or null. */
function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** Optional field: absent/empty is fine, present-but-oversized is truncated not rejected. */
function optional(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

// Deliberately permissive but structural: one @, no whitespace, a dot in the domain.
// A stricter regex rejects real addresses; the address is confirmed by us replying to it.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Indian mobile numbers arrive in four shapes that real people type. All four are valid
 * and all four must be accepted, or genuine leads are lost at the last field.
 * Returns E.164 where derivable.
 */
function normalisePhone(raw: string): string | null {
  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (hadPlus) {
    // Explicit international. Trust the country code the visitor gave.
    if (digits.length < 8 || digits.length > 15) return null;
    return "+" + digits;
  }
  if (/^[6-9]\d{9}$/.test(digits)) return "+91" + digits; // 9876543210
  if (/^91[6-9]\d{9}$/.test(digits)) return "+" + digits; // 919876543210
  if (/^0[6-9]\d{9}$/.test(digits)) return "+91" + digits.slice(1); // 09876543210
  if (digits.length >= 8 && digits.length <= 15) return digits; // unknown shape, kept as digits
  return null;
}

/**
 * Strict international normalisation, used by offers that are not India-specific.
 * Always returns E.164 (`+` followed by 8-15 digits), or null.
 *
 * normalisePhone() above maps a bare ten-digit number to +91 because /submit-lead was
 * built for Indian developers, and its historical rows depend on that. It is untouched.
 * Reusing it here would stamp +91 onto a Gulf brokerage's 05x number, and a WRONG
 * country code is worse than a rejected form: it corrupts normalisedPhone matching and
 * makes every outbound WhatsApp attempt fail while looking perfectly valid in the Sheet.
 *
 * The rule is therefore: REQUIRE a country code, never invent one.
 *
 * An earlier version accepted a bare national number and stored it as digits, on the
 * reasoning that losing a lead to a formatting habit costs more than an unprefixed row.
 * That was the wrong trade for this funnel: an unprefixed Gulf number is not reliably
 * dialable or WhatsApp-reachable, so the "saved" lead is often uncontactable anyway,
 * and it silently breaks phone-based dedup. The form asks for a country code and says
 * so; the frontend enforces the same rule before submit, so a visitor is corrected on
 * the spot rather than rejected after the fact.
 */
function normalisePhoneInternational(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Only characters that legitimately appear in a written phone number. This rejects
  // letters outright, so "call me on 0501234567" cannot be silently reduced to digits.
  if (!/^[+0-9()\-.\s]+$/.test(trimmed)) return null;

  // "+" is a prefix, and there is only ever one.
  const plusCount = (trimmed.match(/\+/g) ?? []).length;
  if (plusCount > 1) return null;
  if (plusCount === 1 && !trimmed.startsWith("+")) return null;

  const digits = trimmed.replace(/\D/g, "");

  let e164Digits: string;
  if (trimmed.startsWith("+")) {
    e164Digits = digits;                 // "+971 50 123 4567"
  } else if (digits.startsWith("00")) {
    e164Digits = digits.slice(2);        // "00971501234567" — ITU prefix, same meaning
  } else {
    return null;                         // no country code, and we will not guess one
  }

  // E.164 allows 8-15 digits including the country code, and no country code begins
  // with 0 — so a leading zero here means the prefix was stripped from a national
  // number rather than a real international one being given.
  if (e164Digits.length < 8 || e164Digits.length > 15) return null;
  if (e164Digits.startsWith("0")) return null;

  return "+" + e164Digits;
}

/**
 * Server-side qualification for brokerage_content_engine.
 *
 * This is the ONLY place the verdict is computed. The browser sends facts — the two
 * answers — and is told the outcome; it never asserts one. See the verdict-key rejection
 * in both handlers.
 */
const QUALIFYING_TEAM_SIZES: readonly string[] = ["5_9", "10_19", "20_plus"];

function isContentQualified(teamSize: string, monthlyShoot: string): boolean {
  return QUALIFYING_TEAM_SIZES.includes(teamSize) && monthlyShoot === "yes";
}

/**
 * A client-supplied verdict means the payload was tampered with or a stale build is
 * deployed. Both intake endpoints fail loudly rather than dropping the field quietly.
 */
const CLIENT_VERDICT_KEYS = ["score", "outcome", "qualified", "status"] as const;

function carriesClientVerdict(body: Record<string, unknown>): boolean {
  return CLIENT_VERDICT_KEYS.some((k) => k in body);
}

const submitLead = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");

  if (request.method !== "POST") {
    return json(405, { ok: false, code: "method_not_allowed" }, origin);
  }

  // Require application/json. Without this the endpoint accepts a CORS *simple request*:
  // text/plain triggers no preflight, so any third-party page could POST leads from a
  // visitor's browser and the write would succeed — the allow-list would only stop them
  // reading the reply, not stop the row being written.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().split(";")[0].trim().startsWith("application/json")) {
    return json(415, { ok: false, code: "unsupported_media_type" }, origin);
  }

  // An Origin that is present but not allow-listed is refused outright. Omitting the
  // response header alone is not a refusal — the write still happened.
  if (origin !== null && !allowedOrigins().has(origin)) {
    return json(403, { ok: false, code: "forbidden_origin" }, origin);
  }

  // Reject an oversized body before reading it into memory.
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { ok: false, code: "malformed_body" }, origin);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, code: "malformed_body" }, origin);
  }

  // Honeypot — FLAG, DO NOT DISCARD.
  //
  // This previously returned stored:false and wrote nothing. In production that silently
  // destroyed real leads: browsers and password managers autofill a hidden field named
  // "website", so any visitor with autofill enabled was classified as a bot, saw only the
  // generic save error, and never reached the calendar. It caught zero spam and lost
  // genuine enquiries.
  //
  // Losing a real developer costs far more than storing a bot row, so a tripped honeypot
  // now stores the lead with status "suspect" instead. The sales queue works "submitted";
  // "suspect" is reviewed separately. `website` is the legacy field name and is still read
  // so pages running the older widget are fixed by this deploy alone.
  const honeypot =
    (typeof body.hp_ref === "string" ? body.hp_ref.trim() : "") ||
    (typeof body.website === "string" ? body.website.trim() : "");
  const suspect = honeypot.length > 0;

  if (carriesClientVerdict(body)) {
    return json(400, { ok: false, code: "malformed_body" }, origin);
  }

  const fields: string[] = [];

  const submissionId = str(body.submissionId, MAX.submissionId);
  if (submissionId === null || !/^[A-Za-z0-9-]{8,64}$/.test(submissionId)) {
    fields.push("submissionId");
  }

  const name = str(body.name, MAX.name);
  if (name === null) fields.push("name");

  const email = str(body.email, MAX.email);
  if (email === null || !EMAIL_RE.test(email)) fields.push("email");

  const phoneRaw = str(body.phone, MAX.phone);
  const normalisedPhone = phoneRaw === null ? null : normalisePhone(phoneRaw);
  if (normalisedPhone === null) fields.push("phone");

  const activeInventory = body.activeInventory;
  if (typeof activeInventory !== "string" ||
      !(ACTIVE_INVENTORY as readonly string[]).includes(activeInventory)) {
    fields.push("activeInventory");
  }

  const monthlyMediaBudget = normaliseMediaBudget(body.monthlyMediaBudget);
  if (monthlyMediaBudget === null) fields.push("monthlyMediaBudget");

  // Consent must be exactly true. Truthy is not consent.
  if (body.consent !== true) fields.push("consent");

  if (fields.length > 0) {
    return json(422, { ok: false, code: "validation_error", fields }, origin);
  }

  const attribution = (typeof body.attribution === "object" && body.attribution !== null)
    ? (body.attribution as Record<string, unknown>)
    : {};

  let result: { submissionId: string; duplicate: boolean };
  try {
    result = await ctx.runMutation(internal.leads.insertLead, {
      submissionId: submissionId as string,
      name: deformula(name as string),
      email: email as string,
      normalisedEmail: (email as string).toLowerCase(),
      phone: phoneRaw as string,
      normalisedPhone: normalisedPhone as string,
      activeInventory: activeInventory as "1_19" | "20_49" | "50_99" | "100_plus",
      monthlyMediaBudget: monthlyMediaBudget as CanonicalMediaBudget,
      consent: true,
      suspect,
      landingPage: safeUrl(body.landingPage, MAX.url),
      referrer: safeUrl(body.referrer, MAX.url),
      utmSource: deformulaOpt(optional(attribution.utm_source, MAX.utm)),
      utmMedium: deformulaOpt(optional(attribution.utm_medium, MAX.utm)),
      utmCampaign: deformulaOpt(optional(attribution.utm_campaign, MAX.utm)),
      utmContent: deformulaOpt(optional(attribution.utm_content, MAX.utm)),
      utmTerm: deformulaOpt(optional(attribution.utm_term, MAX.utm)),
      gclid: deformulaOpt(optional(attribution.gclid, MAX.utm)),
      // Google's cookieless click identifiers. The frontend has always captured these;
      // persisting them is additive and every historical row stays valid without them.
      gbraid: deformulaOpt(optional(attribution.gbraid, MAX.utm)),
      wbraid: deformulaOpt(optional(attribution.wbraid, MAX.utm)),
      deviceCategory: optional(body.device, 16),
      // Kept for operational triage only (did a whole browser family fail?). Truncated,
      // and never used to build a profile.
      userAgent: optional(request.headers.get("User-Agent"), MAX.userAgent),
    });
  } catch {
    // Never leak a stack trace or table name to the browser.
    return json(500, { ok: false, code: "server_error" }, origin);
  }

  return json(
    200,
    result.duplicate
      ? { ok: true, submissionId: result.submissionId, stored: true, duplicate: true }
      : { ok: true, submissionId: result.submissionId, stored: true },
    origin,
  );
});

/* ══════════════════════════════════════════════════════════════════
   POST /submit-content-lead — brokerage_content_engine (VSL-5) intake
   ══════════════════════════════════════════════════════════════════ */

/**
 * A separate handler, not a branch inside submitLead.
 *
 * The two offers ask different questions, so a single handler would have to make every
 * answer optional and then re-tighten per offer — which is exactly the shape of bug this
 * split exists to prevent. /submit-lead's contract is byte-for-byte what it was; this
 * endpoint cannot loosen it, because it cannot reach it.
 *
 * Every safeguard from /submit-lead is reproduced here deliberately: origin allow-list,
 * JSON-only, body cap, bounded strings, honeypot-as-flag, formula neutralisation, safe
 * URLs, idempotency by submissionId, and no stack traces in responses.
 */
const submitContentLead = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");

  if (request.method !== "POST") {
    return json(405, { ok: false, code: "method_not_allowed" }, origin);
  }

  // Same reasoning as /submit-lead: without this, text/plain makes the endpoint a CORS
  // simple request and any third-party page could write rows from a visitor's browser.
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().split(";")[0].trim().startsWith("application/json")) {
    return json(415, { ok: false, code: "unsupported_media_type" }, origin);
  }

  if (origin !== null && !allowedOrigins().has(origin)) {
    return json(403, { ok: false, code: "forbidden_origin" }, origin);
  }

  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { ok: false, code: "malformed_body" }, origin);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, code: "malformed_body" }, origin);
  }

  // The visitor does not decide whether they qualify. A payload asserting a verdict is
  // rejected outright — including the `qualified` boolean the pre-integration page sent.
  if (carriesClientVerdict(body)) {
    return json(400, { ok: false, code: "malformed_body" }, origin);
  }

  // Honeypot: flag, never discard. Same reasoning as /submit-lead — autofill fills
  // hidden fields, and silently binning real applications is the costlier failure.
  const honeypot =
    (typeof body.hp_ref === "string" ? body.hp_ref.trim() : "") ||
    (typeof body.website === "string" ? body.website.trim() : "");
  const suspect = honeypot.length > 0;

  const fields: string[] = [];

  const submissionId = str(body.submissionId, MAX.submissionId);
  if (submissionId === null || !/^[A-Za-z0-9-]{8,64}$/.test(submissionId)) {
    fields.push("submissionId");
  }

  const name = str(body.name, MAX.name);
  if (name === null) fields.push("name");

  const email = str(body.email, MAX.email);
  if (email === null || !EMAIL_RE.test(email)) fields.push("email");

  const companyName = str(body.companyName, MAX.companyName);
  if (companyName === null) fields.push("companyName");

  const phoneRaw = str(body.phone, MAX.phone);
  const normalisedPhone = phoneRaw === null ? null : normalisePhoneInternational(phoneRaw);
  if (normalisedPhone === null) fields.push("phone");

  const teamSize = body.teamSize;
  if (typeof teamSize !== "string" || !(TEAM_SIZE as readonly string[]).includes(teamSize)) {
    fields.push("teamSize");
  }

  const monthlyShoot = body.monthlyShoot;
  if (typeof monthlyShoot !== "string" ||
      !(MONTHLY_SHOOT as readonly string[]).includes(monthlyShoot)) {
    fields.push("monthlyShoot");
  }

  if (body.consent !== true) fields.push("consent");

  if (fields.length > 0) {
    return json(422, { ok: false, code: "validation_error", fields }, origin);
  }

  // Computed here, from validated answers only. `body.offer` is ignored entirely — the
  // endpoint defines the offer, the browser does not get a say.
  const contentQualified = isContentQualified(teamSize as string, monthlyShoot as string);

  const attribution = (typeof body.attribution === "object" && body.attribution !== null)
    ? (body.attribution as Record<string, unknown>)
    : {};

  let result: { submissionId: string; duplicate: boolean; contentQualified: boolean };
  try {
    result = await ctx.runMutation(internal.leads.insertContentLead, {
      submissionId: submissionId as string,
      name: deformula(name as string),
      email: email as string,
      normalisedEmail: (email as string).toLowerCase(),
      phone: phoneRaw as string,
      normalisedPhone: normalisedPhone as string,
      companyName: deformula(companyName as string),
      teamSize: teamSize as "1_4" | "5_9" | "10_19" | "20_plus",
      monthlyShoot: monthlyShoot as "yes" | "no",
      contentQualified,
      consent: true,
      suspect,
      landingPage: safeUrl(body.landingPage, MAX.url),
      referrer: safeUrl(body.referrer, MAX.url),
      utmSource: deformulaOpt(optional(attribution.utm_source, MAX.utm)),
      utmMedium: deformulaOpt(optional(attribution.utm_medium, MAX.utm)),
      utmCampaign: deformulaOpt(optional(attribution.utm_campaign, MAX.utm)),
      utmContent: deformulaOpt(optional(attribution.utm_content, MAX.utm)),
      utmTerm: deformulaOpt(optional(attribution.utm_term, MAX.utm)),
      gclid: deformulaOpt(optional(attribution.gclid, MAX.utm)),
      gbraid: deformulaOpt(optional(attribution.gbraid, MAX.utm)),
      wbraid: deformulaOpt(optional(attribution.wbraid, MAX.utm)),
      deviceCategory: optional(body.device, 16),
      userAgent: optional(request.headers.get("User-Agent"), MAX.userAgent),
    });
  } catch {
    return json(500, { ok: false, code: "server_error" }, origin);
  }

  // `qualified` here is the SERVER's verdict being reported back, which is the opposite
  // direction of the rejected input key. The page uses it to choose the next screen.
  return json(
    200,
    result.duplicate
      ? {
          ok: true,
          submissionId: result.submissionId,
          stored: true,
          duplicate: true,
          qualified: result.contentQualified,
        }
      : {
          ok: true,
          submissionId: result.submissionId,
          stored: true,
          qualified: result.contentQualified,
        },
    origin,
  );
});

/* ══════════════════════════════════════════════════════════════════
   POST /track-event — anonymous first-party funnel telemetry
   ══════════════════════════════════════════════════════════════════ */

const MAX_TELEMETRY_BODY_BYTES = 2 * 1024; // one tiny row; far smaller than a lead

/**
 * Keys that belong to the LEAD, never to anonymous telemetry. Rejected outright with a
 * 400 rather than silently dropped: if a future frontend change starts sending PII here,
 * that is a bug we want to see immediately, not a quiet privacy leak.
 */
const FORBIDDEN_TELEMETRY_KEYS = [
  "name", "email", "phone",
  "normalisedemail", "normalisedphone",
  "activeinventory", "inventory",
  "monthlymediabudget", "media_budget", "mediabudget",
  "consent",
  "questionsandanswers", "questions_and_answers", "calendlyanswers",
  "firstname", "lastname", "fullname",
  // brokerage_content_engine answers. companyName identifies the business as surely as a
  // personal name identifies a person, and the two qualification answers are lead data
  // that belongs on the lead row — the funnel report reads them from there.
  "companyname", "company_name", "company",
  "teamsize", "team_size",
  "monthlyshoot", "monthly_shoot",
];

const trackEvent = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");

  if (request.method !== "POST") {
    return json(405, { ok: false, code: "method_not_allowed" }, origin);
  }

  // Same origin discipline as /submit-lead: a present-but-disallowed Origin is refused
  // outright, not merely denied a readable response.
  if (origin !== null && !allowedOrigins().has(origin)) {
    return json(403, { ok: false, code: "forbidden_origin" }, origin);
  }

  // navigator.sendBeacon can only send a few content types without provoking a preflight
  // it cannot handle, so text/plain is accepted here. Validation is NOT weakened: the
  // body is parsed as JSON and checked identically either way.
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase().split(";")[0].trim();
  if (contentType && !["application/json", "text/plain"].includes(contentType)) {
    return json(415, { ok: false, code: "unsupported_media_type" }, origin);
  }

  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_TELEMETRY_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  const raw = await request.text();
  if (raw.length > MAX_TELEMETRY_BODY_BYTES) {
    return json(413, { ok: false, code: "payload_too_large" }, origin);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json(400, { ok: false, code: "malformed_body" }, origin);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { ok: false, code: "malformed_body" }, origin);
  }

  const offending = Object.keys(body).filter((k) =>
    FORBIDDEN_TELEMETRY_KEYS.includes(k.toLowerCase()),
  );
  if (offending.length > 0) {
    return json(400, { ok: false, code: "pii_rejected", fields: offending }, origin);
  }

  const eventName = body.eventName;
  if (typeof eventName !== "string" ||
      !(FUNNEL_EVENT_NAMES as readonly string[]).includes(eventName)) {
    return json(422, { ok: false, code: "unknown_event", fields: ["eventName"] }, origin);
  }

  const eventId = str(body.eventId, MAX.submissionId);
  if (eventId === null || !/^[A-Za-z0-9-]{8,64}$/.test(eventId)) {
    return json(422, { ok: false, code: "validation_error", fields: ["eventId"] }, origin);
  }

  const sessionId = str(body.sessionId, MAX.submissionId);
  if (sessionId === null || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) {
    return json(422, { ok: false, code: "validation_error", fields: ["sessionId"] }, origin);
  }

  // Which funnel this stage belongs to. Optional: a page that sends nothing is recorded
  // with no offer and reads back as real_estate_acquisition, which is what every event
  // written before VSL-5 existed actually was. A PRESENT but unrecognised value is
  // rejected rather than dropped — silently filing VSL-6's traffic under "acquisition"
  // would corrupt the comparison the offer field exists to make.
  let offer: (typeof OFFERS)[number] | undefined;
  if (body.offer !== undefined && body.offer !== null && body.offer !== "") {
    if (typeof body.offer !== "string" || !(OFFERS as readonly string[]).includes(body.offer)) {
      return json(422, { ok: false, code: "unknown_offer", fields: ["offer"] }, origin);
    }
    offer = body.offer as (typeof OFFERS)[number];
  }

  const clientTs = typeof body.clientTimestamp === "number" &&
    Number.isFinite(body.clientTimestamp) ? body.clientTimestamp : undefined;

  const attribution = (typeof body.attribution === "object" && body.attribution !== null)
    ? (body.attribution as Record<string, unknown>)
    : {};

  let result: { duplicate: boolean };
  try {
    result = await ctx.runMutation(internal.funnel.recordEvent, {
      eventId,
      sessionId,
      eventName: eventName as (typeof FUNNEL_EVENT_NAMES)[number],
      offer,
      clientTimestamp: clientTs,
      submissionId: optional(body.submissionId, MAX.submissionId),
      ctaText: optional(body.ctaText, 120),
      deviceCategory: optional(body.device, 16),
      landingPage: safeUrl(body.landingPage, MAX.url),
      referrer: safeUrl(body.referrer, MAX.url),
      utmSource: deformulaOpt(optional(attribution.utm_source, MAX.utm)),
      utmMedium: deformulaOpt(optional(attribution.utm_medium, MAX.utm)),
      utmCampaign: deformulaOpt(optional(attribution.utm_campaign, MAX.utm)),
      utmContent: deformulaOpt(optional(attribution.utm_content, MAX.utm)),
      utmTerm: deformulaOpt(optional(attribution.utm_term, MAX.utm)),
      gclid: deformulaOpt(optional(attribution.gclid, MAX.utm)),
      gbraid: deformulaOpt(optional(attribution.gbraid, MAX.utm)),
      wbraid: deformulaOpt(optional(attribution.wbraid, MAX.utm)),
      userAgent: optional(request.headers.get("User-Agent"), MAX.userAgent),
    });
  } catch {
    return json(500, { ok: false, code: "server_error" }, origin);
  }

  return json(200, { ok: true, recorded: true, duplicate: result.duplicate }, origin);
});

const preflight = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
});

const http = httpRouter();
http.route({ path: "/submit-lead", method: "POST", handler: submitLead });
http.route({ path: "/submit-lead", method: "OPTIONS", handler: preflight });
http.route({ path: "/submit-content-lead", method: "POST", handler: submitContentLead });
http.route({ path: "/submit-content-lead", method: "OPTIONS", handler: preflight });
http.route({ path: "/track-event", method: "POST", handler: trackEvent });
http.route({ path: "/track-event", method: "OPTIONS", handler: preflight });

export default http;
