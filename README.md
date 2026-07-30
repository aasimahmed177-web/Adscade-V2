# AdScade — real estate client acquisition funnel

A VSL-style booking funnel for **AdScade**, founded by **Aasim Ahmed**. Traffic comes from
YouTube / Demand Gen ads; the page's only job is one booked free audit call.

## Layout

```
site/index.html          the page — one self-contained file, the only build artifact
site/assets/             founder photo
program.md               the autoresearch run spec: artifact, rubric, target, loop rules
docs/ICP.md              who this is for, and who to turn away
docs/design-tokens.md    palette + type, measured off the client's reference site
docs/convex-schema.md    storage handoff — schema, tiering, the one function to change
docs/source/             the three client PDFs, extracted to text
tools/score.mjs          the frozen 1000-point harness
tools/e2e.mjs            behavioural test for the booking form
.claude/skills/          autoresearch · llm-council · playwright-cli
vendor-llm-council/      karpathy/llm-council, vendored
results.tsv              experiment log (untracked)
```

## Run it

```bash
open site/index.html
```

Score the page against the rubric:

```bash
node tools/score.mjs --verbose
```

Test that the form actually works:

```bash
node tools/e2e.mjs
```

## Where the run landed

Baseline **962/1000** → **1000/1000**, then three rounds of LLM-council review and two rounds
of client-directed change. The experiment log is in `results.tsv`; the reasoning is in
`program.md`.

Council scores across the rounds: **66 → 70/72 → 80** out of 100. Each round found things the
deterministic harness is blind to — the harness scored 1000/1000 while the page was quietly
handing disqualified leads a slot in the founder's calendar.

Two things worth knowing about that number:

**The harness is deterministic on purpose.** Every point is a predicate over the built page —
a string that must be present, a contrast ratio that must clear a threshold, an element that
must be keyboard-reachable. No language model scores the page, because an LLM optimizer graded
by an LLM judge converges on whatever the judge is sycophantic about.

**A full score is not a finished page.** After the rubric was maxed, looking at screenshots
found a broken signature element and a click-eating layout shift in the form that the rubric
scored 100% on. Both are fixed. The number is a floor, not a verdict.

## Before this goes live

- **Re-cut the five YouTube end cards.** They say "Book My Free Audit Call"; the page now says
  "Book My Audit Call". The ad scripts' own compliance checklist requires an exact match, and
  mismatch is the most common Demand Gen disapproval.
- **The VSL is not shot.** The slot is built and labelled "in production"; the play control
  expands a text agenda in place rather than pretending to be a video.
- **Convex is not wired.** `submitLead()` logs and returns `{ok:true, pending:true}`. Wiring it
  is a one-function change — see `docs/convex-schema.md`.
- **Confirm the Calendly event** at `calendly.com/aasim-ahmed177/realestate-growth-systems` is
  set to 30 minutes and that its availability matches what the page promises.

## One thing to decide

The ad scripts end on the card **"Book My Free Audit Call"**; the landing page script's hero
button says **"Get My Free Funnel Audit"**. The ads' own compliance checklist requires the CTA
to match the landing page button *exactly*, so they cannot both stand.

The page uses **"Book My Free Audit Call"** throughout — it matches all five video end cards,
and "book a call" describes the actual next step better than "get an audit". If you'd rather
keep the other string, it needs changing on the page and in `tools/score.mjs`, and the ad end
cards stay as they are.
