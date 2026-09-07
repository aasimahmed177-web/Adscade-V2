---
name: llm-council
description: Convene a council of independent reviewer agents that answer or judge a question in parallel, peer-rank each other's work anonymously, then have a chairman synthesize a verdict. Use when a judgement call needs more than one opinion — scoring a landing page, choosing between design directions, stress-testing copy, or producing a defensible numeric score.
---

# LLM Council

Port of [karpathy/llm-council](https://github.com/karpathy/llm-council) to the subagent model.
The full FastAPI/React original is vendored at `vendor-llm-council/` if you ever want the
real multi-provider version (needs `OPENROUTER_API_KEY`).

The point of the council is **anonymized peer review**. A single judge is noisy and
sycophantic. A council that cannot see who wrote what is much harder to fool.

## The three stages

### Stage 1 — Independent responses

Spawn N council members **in parallel, in a single message**, with identical prompts.
Default N = 4. Give every member:

- the exact artifact under review (file path, or the text inline),
- the rubric or question, verbatim and identical for each member,
- an explicit output format.

Members must not talk to each other and must not be told there are other members.
Vary `model` across members when you want genuine diversity of opinion; keep it
constant when you want a variance estimate on one model.

### Stage 2 — Anonymized peer ranking

Collect the N responses. Strip every identifying trace — agent name, model name,
ordering cues, self-references. Relabel them `Response A`, `Response B`, … and keep
a private `label → author` map that you do **not** put in the ranking prompt.

Spawn N rankers in parallel. Each gets all N anonymized responses (including its own,
which it cannot identify) and must end with exactly:

```
FINAL RANKING:
1. Response <X>
2. Response <Y>
...
```

Parse that block. Compute each response's **mean rank position** across all rankers.
Lower is better. That aggregate is the council's confidence signal — a response ranked
first by everyone is worth far more than a bare average of scores.

### Stage 3 — Chairman synthesis

One final agent — the chairman — receives the de-anonymized responses, the aggregate
rankings, and the original rubric. It produces the single answer of record.

The chairman is not an averager. It weights by peer rank, resolves disagreements by
going back to the artifact, and states explicitly where the council split.

## When the council produces a score

For scoring tasks, require each member to return a machine-readable block:

```
SCORES:
<criterion>: <points>/<max>  — <one-line justification>
TOTAL: <n>/<max>
```

Then the council score is the **peer-rank-weighted mean**, not the plain mean:
weight each member's total by `1 / mean_rank`, normalize, sum. This lets a
well-reasoned outlier pull the score, and lets a member the others judged sloppy
have less say.

Report alongside every score: the spread (min/max member total) and the criteria where
members disagreed by more than 15% of that criterion's max. Those are the real
findings — a criterion the council agrees is broken is a fact, a criterion it splits on
is a design question for the human.

## Rules

- **Never let a member see another member's work in stage 1.** That is the whole design.
- **Never reveal authorship during stage 2.** If a response signs itself, redact it.
- **Never skip to stage 3.** A chairman without rankings is just one more opinion.
- Council members judge; they do not edit the artifact. Fixes are the caller's job.
- If members' totals span more than 25% of the max, say so loudly rather than
  reporting a confident midpoint — the rubric is probably ambiguous.
