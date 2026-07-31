import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { ACTIVE_INVENTORY, MEDIA_BUDGET } from "./schema";

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

const MAX_BODY_BYTES = 8 * 1024; // the whole payload is a few hundred bytes
const MAX = {
  name: 200,
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

  // Honeypot. Accept and discard: a bot that gets a 4xx learns what tripped it.
  // Nothing is written, and the caller is told stored:false so the page does not
  // present a fake success or reveal the calendar.
  const honeypot = typeof body.website === "string" ? body.website.trim() : "";
  if (honeypot.length > 0) {
    return json(200, { ok: true, submissionId: null, stored: false }, origin);
  }

  // A client-supplied verdict is a sign the payload was tampered with or that a stale
  // build is deployed. Fail loudly rather than silently dropping the field.
  if ("score" in body || "outcome" in body || "qualified" in body || "status" in body) {
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

  const monthlyMediaBudget = body.monthlyMediaBudget;
  if (typeof monthlyMediaBudget !== "string" ||
      !(MEDIA_BUDGET as readonly string[]).includes(monthlyMediaBudget)) {
    fields.push("monthlyMediaBudget");
  }

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
      monthlyMediaBudget: monthlyMediaBudget as "below_1l" | "1_3l" | "3_5l" | "above_5l",
      consent: true,
      landingPage: safeUrl(body.landingPage, MAX.url),
      referrer: safeUrl(body.referrer, MAX.url),
      utmSource: deformulaOpt(optional(attribution.utm_source, MAX.utm)),
      utmMedium: deformulaOpt(optional(attribution.utm_medium, MAX.utm)),
      utmCampaign: deformulaOpt(optional(attribution.utm_campaign, MAX.utm)),
      utmContent: deformulaOpt(optional(attribution.utm_content, MAX.utm)),
      utmTerm: deformulaOpt(optional(attribution.utm_term, MAX.utm)),
      gclid: deformulaOpt(optional(attribution.gclid, MAX.utm)),
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

const preflight = httpAction(async (_ctx, request) => {
  const origin = request.headers.get("Origin");
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
});

const http = httpRouter();
http.route({ path: "/submit-lead", method: "POST", handler: submitLead });
http.route({ path: "/submit-lead", method: "OPTIONS", handler: preflight });

export default http;
