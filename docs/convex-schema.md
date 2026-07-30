# Convex handoff

Storage is deliberately the **last** thing wired, per the brief. Until then the page captures
leads and logs them, and nothing is lost silently — `submitLead()` returns `{ok:true,
pending:true}` so the success state is honest about the fact that nothing has been persisted
yet.

This document is the contract between the page and Convex. Wiring it up should touch exactly
one function.

## The seam

All egress from the page runs through a single function in `site/index.html`:

```js
async function submitLead(payload) {
  if (window.CONVEX_SUBMIT) return window.CONVEX_SUBMIT(payload);
  console.info('[AdScade] lead captured (no backend wired yet)', payload);
  return { ok: true, pending: true };
}
```

There is no `fetch()` anywhere else, no endpoint URL in the markup, and no analytics call that
carries lead data. To go live you either set `window.CONVEX_SUBMIT` before the page script
runs, or replace the body of `submitLead`. Nothing else changes.

## Payload

```ts
{
  businessType: "independent_broker" | "brokerage_team" | "channel_partner" | "developer" | "other",
  city:         string,   // free text — "Thane West", "Gurugram Sector 79"
  inventory:    "active" | "launching" | "none",
  spend:        "none" | "under_50k" | "50k_150k" | "150k_300k" | "300k_plus",
  leadSource:   "portals" | "self_ads" | "freelancer" | "referrals" | "nothing",
  cpql:         "tracked" | "rough" | "unknown",

  name:         string,
  business:     string,
  phone:        string,   // 10 digits, no country code, validated /^[6-9]\d{9}$/
  email:        string,
  consent:      true,     // always true — the form cannot submit without it

  source:       string,   // utm_source from the query string, else "direct"
  submittedAt:  string    // ISO 8601
}
```

## Schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  leads: defineTable({
    businessType: v.union(
      v.literal("independent_broker"), v.literal("brokerage_team"),
      v.literal("channel_partner"), v.literal("developer"), v.literal("other")),
    city:       v.string(),
    inventory:  v.union(v.literal("active"), v.literal("launching"), v.literal("none")),
    spend:      v.union(
      v.literal("none"), v.literal("under_50k"), v.literal("50k_150k"),
      v.literal("150k_300k"), v.literal("300k_plus")),
    leadSource: v.union(
      v.literal("portals"), v.literal("self_ads"), v.literal("freelancer"),
      v.literal("referrals"), v.literal("nothing")),
    cpql:       v.union(v.literal("tracked"), v.literal("rough"), v.literal("unknown")),

    name:     v.string(),
    business: v.string(),
    phone:    v.string(),
    email:    v.string(),
    consent:  v.boolean(),

    source:      v.string(),
    submittedAt: v.string(),

    // derived server-side, never trusted from the client
    tier:   v.union(v.literal("A"), v.literal("B"), v.literal("disqualified")),
    status: v.union(
      v.literal("new"), v.literal("contacted"),
      v.literal("booked"), v.literal("closed"), v.literal("dropped")),
  })
    .index("by_status", ["status"])
    .index("by_tier", ["tier"])
    .index("by_phone", ["phone"]),
});
```

## Tiering

The six questions exist to sort leads before Aasim's calendar is touched. Compute `tier` in
the mutation, not on the client — a client-side tier is a client-editable tier.

- **disqualified** — `inventory === "none"` **or** `spend === "none"`. These are the two hard
  disqualifiers from `docs/ICP.md` §4. The page already tells these visitors honestly that
  they're a bad fit, and still lets them submit; the tier keeps them out of the booking queue.
- **A** — `spend` is `50k_150k` or higher, **and** `inventory === "active"`, **and** `cpql` is
  `rough` or `unknown`. This is the ICP sentence almost verbatim: real budget, live inventory,
  no idea what a qualified lead costs them. Book these same day.
- **B** — everything else. Real, worth a call, lower priority.

## Mutation

```ts
// convex/leads.ts
import { mutation } from "./_generated/server";

export const submit = mutation({
  args: { /* mirror the payload shape above */ },
  handler: async (ctx, args) => {
    if (!args.consent) throw new Error("consent required");
    if (!/^[6-9]\d{9}$/.test(args.phone)) throw new Error("invalid phone");

    const dq   = args.inventory === "none" || args.spend === "none";
    const hot  = ["50k_150k", "150k_300k", "300k_plus"].includes(args.spend)
               && args.inventory === "active"
               && (args.cpql === "rough" || args.cpql === "unknown");

    return await ctx.db.insert("leads", {
      ...args,
      tier: dq ? "disqualified" : hot ? "A" : "B",
      status: "new",
    });
  },
});
```

Revalidate `consent` and `phone` on the server even though the page checks both — the page is
not a trust boundary.

## Wiring order, when the time comes

1. `npx convex dev`, add the schema and mutation above.
2. Load the Convex browser client in `index.html` and set `window.CONVEX_SUBMIT` to a thin
   wrapper around `api.leads.submit`.
3. Confirm the page still scores 1000 — the harness checks that no hardcoded endpoint has
   crept into the markup.
4. Only then point ad spend at the page.

## Still open before launch

These are real blanks in `site/index.html`, not oversights to be discovered later:

- `hello@adscade.in` and `+91 90000 00000` are placeholders. Both appear in the footer and in
  the form's network-error message.
- `privacy.html` and `terms.html` are linked but not yet written. Google Demand Gen will not
  approve the page without a reachable privacy policy.
- The VSL is not shot. The slot currently scrolls to the form on click.
- The canonical URL assumes `https://adscade.in/`.
