# Design tokens

Extracted by computing styles on the reference the client supplied —
`https://workshop.magicalreadersclub.com/` — then adapted for AdScade.

The brief says to follow that reference for design, font and typography. So the *system* is
inherited wholesale. What changes is the subject: that page sells a ₹99 reading workshop to
professionals; this one books a free audit call with a real estate broker. Same instrument,
different tune.

## Palette

Measured off the reference (rgb → hex):

| Token | Hex | Source on reference | Use here |
|---|---|---|---|
| `--ink` | `#05100A` | `rgb(5,16,10)` | Page background — deep green-black |
| `--ink-warm` | `#0F0D08` | `rgb(15,13,8)` | Alternating section background |
| `--forest` | `#1A3322` | `rgb(26,51,34)` | Raised cards, panels, form surface |
| `--cream` | `#EAE0C8` | `rgb(234,224,200)` | Primary text — the dominant colour by count |
| `--gold` | `#E0B865` | `rgb(224,184,101)` | Emphasis, eyebrows, rules, the CTA fill |
| `--gold-deep` | `#C9A04A` | `rgb(201,160,74)` | Borders, hairlines, secondary gold |
| `--clay` | `#D25242` | `rgb(210,82,66)` | The single warning/urgency colour |

Two additions of my own, both derived rather than invented:

| Token | Hex | Why |
|---|---|---|
| `--cream-dim` | `#A9A290` | The reference leans on `rgba(cream, .6)` constantly; naming it avoids scattering alphas |
| `--clay-text` | `#E8A395` | `--clay` is a surface colour; as text on our dark grounds it sits at 3.3:1. This is the same hue lifted until it clears AA everywhere (min 6.5:1). Reference uses this exact tint for the same job. |
| `--leak` | `#D98A76` | The money-leak diagram's loss labels. Started at `#8E3B2E`, which read as loss but only reached 2.6:1 on `--ink-warm` — illegible. Lifted until it clears AA (7.3:1) while staying clearly rust rather than gold. |

**Discipline:** gold is the only colour allowed on a call-to-action. Clay is for warnings and
disqualifiers exclusively. If clay ever appears on something the user is supposed to click,
that is a bug.

## Type

The reference loads three families. All three are on Google Fonts.

| Role | Family | Weights | Notes |
|---|---|---|---|
| Display | **Instrument Serif** | 400 + 400 italic | High-contrast serif. Carries the headline. The italic is the reference's signature move — one italicized phrase per headline, never two. |
| Body / UI | **Inter Tight** | 400, 500, 600, 700, 800 | Everything that isn't a headline. Tight tracking is the point; do not substitute plain Inter. |
| Accent | **Fraunces** | 500 | Used on the reference at ~22px for pull-quotes and testimonial voice. Sparingly. |

### Scale

The reference's most-used sizes cluster at 9.5, 10, 11, 12, 13, 14, 15, 16px for UI and jumps
hard for display. That gap is deliberate — small utility type, enormous headlines, very little
in between.

```
--t-micro   0.66rem   /* 10.5px — ticker, legal, eyebrow */
--t-label   0.72rem   /* 11.5px — labels, chips, meta */
--t-small   0.84rem   /* 13.5px — captions, helper text */
--t-body    1.0rem    /* 16px    — body copy */
--t-lead    1.18rem   /* 19px    — subheads, lead paragraphs */
--t-h3      1.6rem
--t-h2      clamp(2rem, 4.5vw, 3.2rem)
--t-h1      clamp(2.6rem, 7vw, 5.4rem)
```

Uppercase utility type carries `letter-spacing: .14em` and weight 700 — that combination is
what makes the reference's small text read as *engineered* rather than merely small.

## Layout

- Content column: `min(1120px, 92vw)`
- Section rhythm: `clamp(4.5rem, 9vw, 7.5rem)` vertical padding
- Radius: 4px on inputs and chips, 14px on cards, 999px on pills. Nothing else.
- Hairlines are `1px solid rgba(201,160,74,.22)` — gold at low alpha, never grey.

## Signature element

The reference's signature is its gold-bordered pricing card with the countdown.

Ours is **the leak diagram**: a vertical funnel of four stages (Ad → Landing page → Follow-up
→ Site visit) with rupee marks draining out of the side of each stage. It is the literal
picture of the offer's core thesis — "the funnel leaks and you lose money without knowing
where" — and it is the one thing on the page a broker will describe to someone else.

It is the only place on the page where `--leak` appears, and the only element with meaningful
animation. Everything else stays quiet so it can be loud.
