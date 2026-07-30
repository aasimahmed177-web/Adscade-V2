# program.md — AdScade landing page autoresearch

This is the run specification. The method is in `.claude/skills/autoresearch/SKILL.md`.
Read that first, then this.

## The experiment

**Artifact under test:** `site/index.html` — a single self-contained file. This is the *only*
file the loop may edit.

**Read-only, in scope for context:**

- `docs/ICP.md` — who the page is for
- `docs/source/` — the three client PDFs, extracted (ad scripts, landing page script,
  offer & positioning blueprint)
- `docs/design-tokens.md` — palette and type extracted from the reference site
- `tools/score.mjs` — the harness. **Frozen. Never edit to make a number go up.**

**Metric:** `score` out of **1000**, printed by `node tools/score.mjs`. Higher is better.
`node tools/e2e.mjs` is the companion behavioural test — the harness checks the page is built
right, e2e checks it actually works. Both must pass before shipping.

**Target:** **1000 / 1000**, reproduced on two consecutive runs.

**Budget:** each experiment is one edit + one scoring run. A scoring run takes ~10–20
seconds, so the loop is fast — there is no excuse for batching two ideas into one run.

## Why the harness is deterministic

karpathy's original loop measured `val_bpb`, a number that cannot be argued with. A landing
page's "quality" can be argued with, and if the judge is a language model then the optimizer
and the judge share a blind spot — the loop will happily converge on whatever the judge is
sycophantic about.

So every one of the 1000 points is a **concrete predicate over the built page**: a string
that must be present, a computed style that must match, a contrast ratio that must clear a
threshold, an element that must exist and be reachable by keyboard. Subjective goals are
encoded as objective proxies. The proxies are imperfect. They are *fixed*, which is what
matters — a fixed imperfect ruler still tells you which of two pages is better.

Where the harness cannot see something (does the copy actually *land*?), the LLM council
(`.claude/skills/llm-council/SKILL.md`) is the tie-break, but its verdict **never enters the
score**. It generates hypotheses for the next experiment. The number stays untouched.

## The rubric — 1000 points

| # | Category | Points | What it measures |
|---|---|---:|---|
| 1 | Message match & congruency | 150 | Page matches the YouTube ads exactly — headline, CTA string, the five ad angles all landing somewhere |
| 2 | VSL funnel architecture | 150 | Video slot, CTA placement and repetition, single conversion goal, no leaks off-page |
| 3 | Qualification form | 120 | The six filter questions, consent, progressive disclosure, validation, error handling |
| 4 | Copy & ICP resonance | 130 | Proof-of-ICP vocabulary, objection coverage, specificity, no filler |
| 5 | Visual design & typography | 150 | Fidelity to the reference token system, type scale, spacing rhythm, the signature element |
| 6 | Ad-policy compliance | 120 | Banned phrases absent, guarantee qualified, privacy/terms present, disclaimer, business identity |
| 7 | Technical quality | 120 | Responsive to 360px, a11y (focus, labels, contrast, reduced motion), meta/OG, page weight |
| 8 | Convex readiness | 60 | Form submission isolated behind one adapter, schema documented, no hardcoded endpoint |

Full per-criterion breakdown lives in `tools/score.mjs` — the code is the specification.

## Categories 1–8: what "full marks" means

**1. Message match.** The CTA string is `Book My Audit Call`. That exact string is
the only primary CTA text permitted anywhere on the page.

> **Spec change, 30 Jul 2026.** This was `Book My Free Audit Call` until the client asked for
> "free" to be removed from the page. The harness constant changed with it. This is legitimate
> — the harness enforces whatever the ads say, and the client changed what they say — but it is
> the one kind of edit that must never happen for any other reason. **The five YouTube end cards
> still read "Book My Free Audit Call" and must be re-cut**, or Demand Gen will disapprove on
> ad↔page mismatch.

The hero headline must be `Stop Losing Money on Scattered Real Estate Marketing`, character
for character, for the same reason. All ten ad angles across both script sets — money leak,
11 PM follow-up, the buyer who walked, freelancer overwhelm, losing to someone faster, the
unsold unit, the empty site visit, the off-season silence, shared portal leads, being replaced
by a listing page — must each have a recognizable home on the page.

**2. VSL architecture.** There is no video yet. Full marks are for building the *slot*
correctly: a 16:9 container with a poster frame, a play affordance, a duration hint, and a
CTA that appears both above and below it. Exactly one conversion action exists on the page.
Zero outbound links except privacy, terms, and the footer contact.

**3. Qualification form.** Six questions, in the order defined in `docs/ICP.md` §4, each one
mapping to a disqualifier. Consent checkbox unchecked by default. Inline validation. A
success state that tells the user what happens next.

**4. Copy.** Measured by presence of ICP-specific vocabulary (CPQL, site visit, channel
partner, inventory, portal leads, WhatsApp), by objection coverage (all five from ICP §7),
and by absence of filler ("leverage", "seamless", "cutting-edge", "revolutionize").

**5. Visual design.** The palette and faces from `docs/design-tokens.md` must be the ones
actually computed on the page. A type scale with at least five distinct steps. The signature
element — the leak diagram — must exist and be the page's most distinctive component.

**6. Compliance.** Every banned word from the landing-page script's avoid-list absent. The
guarantee present *and* accompanied by its qualifying definition of "qualified lead". Footer
carries business name, contact, city, privacy link, terms link, and the results-vary
disclaimer.

**7. Technical.** No horizontal scroll at 360px. Every interactive element keyboard-focusable
with a visible ring. Text contrast ≥ 4.5:1. `prefers-reduced-motion` respected. Title,
description, OG tags. Total page weight under 500 KB.

**8. Convex readiness.** All form submission goes through a single `submitLead()` function
with a documented payload shape, so wiring Convex later is a one-function change and touches
nothing else.

## What is deliberately NOT scored

- The VSL video itself — not shot yet.
- Real testimonials or case studies — none exist, and fabricating them is a serious policy
  violation, not a shortcut.
- Live Convex integration — deliberately last, per the brief.

These are the v2 gates. The page ships with honest placeholders for all three.

## Loop discipline for this run

- Branch: `autoresearch/<tag>`, created off the current commit.
- `results.tsv` at repo root, tab-separated, untracked.
- Baseline is run #1, unmodified v1 page.
- One hypothesis per experiment, written down before the edit.
- Keep on improvement, `git reset --hard` on flat-or-worse.
- After three consecutive discards, stop nudging and attack the lowest-scoring category
  structurally.
- Do not stop to ask. Stop at 1000 twice over, or on human interrupt.
