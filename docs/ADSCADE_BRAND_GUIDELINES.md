# Adscade — Brand Guidelines

Version 1.0 · 30 July 2026
Derived from the live implementation (`site/index.html`; currently published at `/vsl-5/`).

The brand name is **Adscade**. One capital A, everything else lower case. Never AdScade,
AdsCade, Adscape or adScade. This applies in copy, code, filenames, email signatures, ad
accounts and invoices.

---

## A. Brand foundation

**Master positioning**

> Adscade builds the system between paid attention and qualified pipeline.

**Master-brand tagline**

> From paid attention to qualified pipeline.

**Service descriptor**

> Real Estate Acquisition Systems

The tagline is the master-brand line. It belongs on the company site, decks, proposals and
social profiles. It does **not** replace the campaign-specific landing page headline —
The landing page leads with "Stop Losing Money on Scattered Real Estate Marketing" because that
headline matches the ad that brought the visitor. Ad-to-page match beats brand consistency
on a paid landing page, every time.

### Personality

Analytical · Direct · Composed · Commercially aware · Specialist · Technically capable ·
Premium without being theatrical.

The test: would a 55-year-old developer who has been pitched by six agencies find this
credible, or would he file it with the other five?

### The brand must never sound

Loud · trend-chasing · overly corporate · artificially luxurious · like a property developer ·
like a cheap lead-generation vendor · like an AI automation template.

Two failure modes are worth naming because they are the easy ones to fall into:

- **Luxury drift.** Gold on dark reads as a property developer or an investment fund if the
  copy goes vague and aspirational. The antidote is specificity — numbers, mechanisms, and
  named stages of a funnel.
- **Agency drift.** The moment the copy says "scale", "10X" or "done-for-you" three times, it
  reads as a template. The antidote is describing what is actually operated.

---

## B. Logo system

The mark is a gold triangle enclosing a stylised A/S monogram, paired with an
Instrument Serif wordmark.

| Asset | File | Use |
|---|---|---|
| Monogram (primary) | `site/assets/adscade-mark.png` | Header lockup, footer, favicon source |
| Favicon | `site/assets/favicon.png` | 64px browser tab icon |
| Horizontal lockup | mark + live `Adscade` text in Instrument Serif | Site header, footer |
| Social/OG card | `site/assets/og.jpg` | 1200×630 link previews |

**The wordmark is set as live type, not baked into the image.** The supplied logo's wordmark
is bronze `#64481C`, which fails contrast on the dark ground. Setting it in Instrument Serif
keeps it legible, scalable and crisp at every size, and matches the mark's own serif.

**Clear space:** at least the height of the internal "A" shape on all four sides.

**Minimum size:** 24px tall for the monogram. Below that the interior detail closes up.

Do not: stretch it · add glow or drop shadow · place it over busy imagery · change the gold ·
recreate the wordmark in another font · rotate the monogram · apply multiple gradients ·
capitalise the name inconsistently.

Do not redesign the mark. Technical cleanup (background removal, format conversion) is fine.

---

## C. Colour

| Token | Hex | Role |
|---|---|---|
| `--adscade-bg` | `#03140D` | Deep forest. Page ground. |
| `--adscade-bg-elevated` | `#0A1D14` | Raised surfaces — video frame, report card |
| `--adscade-panel-green` | `#163A28` | Functional surfaces — cards, form |
| `--adscade-panel-dark` | `#171209` | Editorial surfaces — comparison, explanatory bands |
| `--adscade-gold` | `#E2B95B` | Buttons, small labels, emphasised words, data |
| `--adscade-gold-hover` | `#F0C96B` | Hover only |
| `--adscade-cream` | `#F3E8D2` | Headlines |
| `--adscade-text` | `#EEE5D5` | Body copy |
| `--adscade-muted` | `#B5AA96` | Secondary copy, captions |
| `--adscade-border` | `rgba(226,185,91,.22)` | Hairlines, card borders |
| `--adscade-border-strong` | `rgba(226,185,91,.42)` | Emphasised borders, outline buttons |

### Rules

- **Gold is for emphasis, never for paragraphs.** Buttons, eyebrows, single emphasised words,
  numeric values. A paragraph set in gold looks like a warning.
- **Cream for headlines, muted cream for secondary copy.** Body text is `--adscade-text`.
- **Green panels are functional** (things you interact with). **Brown-black panels are
  editorial** (things you read). Keeping that split is what stops the page feeling like an
  undifferentiated dark slab.
- **Red is an error colour, not a brand colour.** `#D25242` appears only on form validation
  and disqualification states. It must never be decorative. As *text* it needs lifting to
  `#E8A395` to clear AA on our grounds.
- **No royal blue anywhere.** If a blue appears, it is a host-theme leak, not the brand.

### Verified contrast (against `#03140D`)

| Combination | Ratio | Verdict |
|---|---|---|
| `--adscade-text` on bg | 14.9:1 | AAA |
| `--adscade-cream` on bg | 15.4:1 | AAA |
| `--adscade-muted` on bg | 8.9:1 | AAA |
| `--adscade-gold` on bg | 8.9:1 | AAA |
| `#1A1204` on `--adscade-gold` (button) | 8.6:1 | AAA |

Contrast is enforced automatically by `tools/score.mjs`, which composites translucent
layers before measuring. Any change that drops text below AA fails the build.

---

## D. Typography

Two families. Never three.

| Role | Family | Notes |
|---|---|---|
| Display | **Instrument Serif** (400, 400 italic) | Headlines, short emphasised phrases, pull-quotes |
| Everything else | **Inter Tight** (400, 600, 700, 800) | Body, buttons, forms, tables, data, labels, legal |

The italic is the signature move: **one italicised phrase per headline, never two.**

### Scale

| Token | Desktop | Mobile |
|---|---|---|
| H1 | `clamp(52px, 5vw, 76px)` | `clamp(39px, 11vw, 52px)` |
| H2 | `clamp(34px, 4vw, 54px)` | same |
| H3 | 26px | 26px |
| Body | 17px | 16px |
| Lead | 19px | 17px |
| Small | 16px | 16px |
| Label / micro | 12px | 12px |

**Floors that are not negotiable:** no reading copy below 16px, no label below 12px, no form
input below 16px (iOS zooms the page otherwise).

Line height 1.5–1.6 for paragraphs. Paragraph measure 55–70 characters (`max-width: 62ch`).

Uppercase utility type carries `letter-spacing: .1em` minimum, `.14em` typical, at weight
700–800. That combination is what makes small type read as engineered rather than merely
small.

Never set long paragraphs in the display serif.

---

## E. Writing and voice

British/Indian English — *optimise*, *organised*, *analyse*. Match the existing site.

### How to write

- Short, complete sentences. Explain the commercial consequence.
- Be specific. A number the reader recognises beats an adjective.
- Calm confidence. Never exclamation marks.
- Describe the **system**, not just the channel.
- Distinguish carefully: *enquiries* → *qualified enquiries* → *booked calls* → *site visits*
  → *revenue*. Collapsing these is how vendors mislead, and this buyer notices.
- Say what Adscade actually operates. Never imply capability that does not exist.

### Preferred vocabulary

Qualified pipeline · acquisition system · enquiry quality · funnel · qualification · sales
feedback · conversion tracking · follow-up · buyer journey · reporting · managed system.

### Avoid

Scale · AI-powered · revolutionary · dominate · 10X · game-changing · guaranteed · secret ·
hack · explode your revenue · done-for-you.

"Built and managed as one system" is preferred to repeating "done-for-you".

### Five correct examples

1. "Adscade connects your ads, landing pages, qualification, follow-up and conversion
   tracking into one managed acquisition system."
2. "You are not short of enquiries. You are losing them in transit."
3. "Every Monday, know where every enquiry stands."
4. "A 'qualified lead' is defined as a submission meeting the budget, location and timeline
   criteria agreed in writing at onboarding."
5. "We don't promise a number — that depends on your inventory, your price and your market."

### Five incorrect examples

1. ~~"10X your real estate sales with our revolutionary AI-powered funnel."~~ — every banned word at once.
2. ~~"We guarantee 50 qualified leads in 30 days."~~ — a number we cannot support.
3. ~~"India's #1 real estate marketing agency."~~ — unverifiable superlative, and an ad-policy risk.
4. ~~"Unlock explosive growth and dominate your market."~~ — says nothing, sounds like everyone.
5. ~~"Our done-for-you done-for-you system does it all for you."~~ — filler standing in for a mechanism.

---

## F. Photography and imagery

**Use:** real founder photography · real working environments · campaign interfaces · funnel
diagrams · reporting examples · carefully anonymised dashboards · architectural imagery only
where contextually relevant.

**Never use:** generic handshakes · teams pointing at charts · high-fives · luxury skyscrapers
used decoratively · money graphics · rockets · AI-generated business people · fabricated
dashboard screenshots · unverifiable client screenshots.

Any sample data shown must be labelled as illustrative — the page does this twice
("Illustrative funnel", "Sample reporting view"). Presenting a mock-up as a client result is
a serious ad-policy violation, not a shortcut.

Founder photography: consistent crop, 4:5 portrait, no stretching, no fake studio background,
no heavy filtering, descriptive alt text. The image may be personal rather than a formal
headshot — that is acceptable and often more credible, provided the crop and treatment are
deliberate.

---

## G. Icons and diagrams

One family: simple line icons, rounded joins, 1.5–2px stroke, in gold, cream or muted cream.
Never mix emoji with drawn icons.

### The Adscade diagram language

The house motif is the connected pipeline:

```
Paid attention → Message → Landing experience → Qualification
              → Follow-up → Sales pipeline → Revenue feedback
```

Two on-page expressions of it today:

- **The leak diagram** — horizontal bars where the bar width *is* the number, so the final
  4% renders as a sliver. The taper is the argument.
- **The delivery strip** — four labelled stages across one line.

Reuse this motif across site sections, decks, proposals, social and reports. It is the single
most recognisable thing the brand owns.

---

## H. UI components

| Component | Spec |
|---|---|
| Primary button `.cta` | Gold fill `#E2B95B`, ink text `#1A1204`, 999px radius, uppercase 800 weight, `.1em` tracking, min-height 52px |
| Secondary button `.cta--ghost` | Transparent, gold text, `--adscade-border-strong` border |
| Text link | Gold, underline offset 3px |
| Editorial card `.card` | `--adscade-panel-green`, hairline border, 14px radius |
| Elevated surface | `--adscade-bg-elevated` — video frame, report card |
| Form field | Dark inset ground, 4px radius, 16px text minimum, gold focus ring |
| Radio option `.opt` | Full row clickable, 52px min height, gold fill when checked |
| Comparison | Two columns desktop; two stacked cards below 760px |
| Accordion `.faq__q` | Full-width button, `+` rotating to `×`, `aria-expanded` + `aria-controls` |
| Metric row `.report__row` | Label left in body size, value right in serif gold |
| Eyebrow | 12px, 800 weight, `.14em` tracking, uppercase, gold |
| Sticky mobile CTA `.dock` | Full-width gold, safe-area inset, dismissible, hides whenever a real CTA is on screen |

**Radius scale:** 0 · 2px · 4px · 10px · 14px · 50% · 999px. Nothing else.

Buttons must not use exaggerated gradients, glow, bounce or pulsing. Motion is limited to a
2px hover lift and a 0.18s ease. `prefers-reduced-motion` is respected globally.

---

## I. Brand architecture

**Master brand: Adscade.** Service descriptors sit beneath it, never beside it:

- Adscade Real Estate Acquisition System
- Adscade YouTube Acquisition System
- Adscade Lead Qualification System

Every service shares one logo, one palette, one type system, one voice, one UI kit, one
reporting style and one pipeline diagram language. Do not create a separate visual identity
per service — the whole positioning is that these are one connected system, and a fragmented
identity would argue against it.

---

## Enforcement

Much of this is machine-checked on every build:

- `node tools/score.mjs` — palette actually computed on the page, both families in use, type
  scale, contrast (with proper alpha compositing), tap targets, radius discipline, uppercase
  tracking, banned claim phrases, single H1.
- `node tools/e2e.mjs` — CTA string consistency, no decorative red, no reading copy under
  16px, no horizontal overflow, comparison stacking, sticky-CTA behaviour.

If a change breaks the brand, the build says so before a visitor does.
