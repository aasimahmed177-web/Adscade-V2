---
name: autoresearch
description: Run an autonomous keep-or-discard experiment loop against a fixed scoring harness — edit one artifact, score it, keep the change if the score improved, revert if it didn't, commit each accepted step, and repeat without stopping to ask. Use when optimizing something measurable toward a target score (a landing page, a prompt, a training script).
---

# Autoresearch

Port of [karpathy/autoresearch](https://github.com/karpathy/autoresearch) from
"minimize val_bpb by editing train.py" to "maximize a rubric score by editing an artifact."
Everything structural is unchanged: one file under test, one frozen metric, a fixed
per-experiment budget, a git branch that only advances on wins.

The project's own `program.md` is the concrete instantiation — the artifact, the harness,
the rubric, the target. **Read `program.md` first.** This file is the method; that file is
the run.

## Non-negotiables

1. **The harness is frozen.** You may never edit the scorer, the rubric, or the weights to
   make a number go up. That is the single failure mode that invalidates the whole run. If
   the rubric is genuinely wrong, stop the loop and say so to the human — do not patch it
   mid-run.
2. **One artifact is in scope.** Everything else is read-only.
3. **Baseline first.** The very first run scores the artifact completely unmodified. No
   change is ever evaluated against anything but a real, recorded baseline.
4. **One idea per experiment.** Two changes in one run teach you nothing about either.
5. **Score, then judge.** Never decide a change was good because it looks good. The number
   decides.

## The loop

```
LOOP:
  1. git status — confirm which branch/commit you are on
  2. Pick ONE hypothesis. Write it down before you touch anything.
  3. Edit the artifact
  4. git commit
  5. Run the harness, redirecting output:  <scorer> > run.log 2>&1
  6. Read only the summary line out of run.log — do not flood context with the full log
  7. If the run errored, read the tail of run.log, fix if trivial, else log a crash and move on
  8. Append a row to results.tsv
  9. IMPROVED  → keep the commit, branch advances
     EQUAL/WORSE → git reset --hard back to the previous commit
```

`results.tsv` is tab-separated (commas break descriptions) and untracked by git:

```
commit	score	max	status	description
a1b2c3d	742	1000	keep	baseline
b2c3d4e	787	1000	keep	move the qualifier above the fold
c3d4e5f	731	1000	discard	swap hero serif for a grotesk
```

Status is `keep`, `discard`, or `crash`.

## Judgement inside the loop

**Simplicity criterion.** All else equal, simpler wins. A tiny gain that costs 200 lines of
tangle is not a gain. A change that scores flat but deletes code is a keep. Weigh the
complexity cost against the size of the improvement, every time.

**Plateaus are information.** Three or four discards in a row means the current direction is
mined out — that is the signal to make a structural change, not to keep nudging. Go back to
the rubric, find the criterion losing the most points, and attack that one directly instead
of polishing what already scores well.

**Diminishing returns near the target.** As the score approaches the ceiling the remaining
points are concentrated in a few stubborn criteria. Read the per-criterion breakdown, not
the total.

## Stopping

Stop when **either**:

- the target score in `program.md` is reached and reproduced on a second scoring run
  (one run can be noise — a target hit once is not a target hit), **or**
- the human interrupts.

Otherwise: **do not stop, and do not ask.** No "should I continue?", no "is this a good
place to pause?". The human may be asleep. If you run out of ideas, you have not run out
of ideas — re-read the rubric, re-read the source material, look at the criteria scoring
worst, combine two near-misses, or try something structurally radical. Ideas are cheap
because reverting is cheap.

## Reporting

When the loop does end, report: baseline score, final score, number of experiments,
keep/discard counts, and the three changes that moved the number most. The narrative of
what worked is worth more than the final artifact.
