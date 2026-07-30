# Proposed privacy-policy amendment

> ## ⚠ OWNER / LEGAL REVIEW REQUIRED BEFORE ANALYTICS ACTIVATION
>
> This is a drafting aid prepared by the implementation team. It is **not legal advice** and
> must not be published as final wording without review by the owner and, where appropriate,
> a qualified adviser familiar with India's Digital Personal Data Protection Act, 2023.
>
> **Do not enable Google Tag Manager, Analytics, Ads conversion measurement or remarketing
> until the published policy reflects what is actually running.**

Version 1.0 · 31 July 2026 · concerns `site/privacy.html`

---

## Why this is needed

The published policy currently states:

> "We do not run advertising pixels, session recording, or third-party analytics on this page."
>
> "This site sets no cookies."

**Both statements are true today** — no container is installed and the event layer is inert.
They become **false the moment GTM is connected**, and a privacy policy that contradicts the
site's actual behaviour is the specific failure regulators and ad platforms look for.

Two other gaps exist regardless of analytics:

1. **Calendly** is now embedded inline on the page for qualified visitors. The current policy
   describes Calendly as a page the visitor is handed to, not an embed loaded in-page.
2. **Form storage** now writes to the site's own database via a WordPress endpoint. The policy
   says submissions are stored "with our hosting and database provider", which is broadly
   right but does not mention the hashed IP retained for rate limiting.

---

## Sections requiring change

| § in `privacy.html` | Status now | Action |
|---|---|---|
| "What we collect" | Lists form fields only | Update field list; add hashed IP |
| "Where it is stored" | Generic | Name the site database; state retention |
| "Scheduling" | Describes hand-off | Rewrite for an inline embed |
| "Cookies" | "This site sets no cookies" | **Must change before GTM** |
| — | No analytics section | **Add before GTM** |
| — | No advertising/remarketing section | **Add before Ads/remarketing** |

---

## Draft replacement wording

### What we collect — replace the field list

> Only what you submit through the qualification form on this site:
>
> - Your name, company or developer name, and project name if you give one
> - The city your project is in
> - Your work email address and WhatsApp or phone number
> - Your answers to the six qualification questions — role, inventory scale, typical unit
>   price, advertising budget, follow-up process and current bottleneck
> - The campaign parameters in the link you arrived on (`utm_*`, `gclid`), the page address
>   and the referring page
> - A one-way hashed form of your IP address, used only to limit automated submissions. The
>   hash cannot be reversed to recover your IP address.
>
> We use your answers to assess whether the service is a suitable fit. That assessment is
> made on our own systems and is not shared with advertising platforms.

### Where it is stored

> Submissions are stored in this website's own database, hosted with our web hosting
> provider, and are accessible only to Adscade staff working on your enquiry. Enquiries that
> become clients are retained for the engagement and three years afterwards for tax and
> contractual records. Enquiries that do not become clients are deleted within twelve months,
> or sooner on request.

### Scheduling — replace the existing section

> If your answers indicate the service may be a fit, a Calendly booking calendar is loaded
> directly into the page so you can choose a time. Calendly is a third-party scheduling
> service with its own privacy policy. When the calendar loads, Calendly may set cookies and
> receives your browser's technical information.
>
> Your name and email address are passed to the calendar to save you retyping them. Your
> phone number, your company details and your qualification answers are **not** passed to
> Calendly. If you close the calendar without booking, no booking data is created.

### Cookies — replace entirely, **before GTM goes live**

> This site uses cookies and similar technologies for the following purposes:
>
> - **Necessary** — to keep the form working and to limit automated submissions.
> - **Analytics** — Google Analytics, loaded through Google Tag Manager, to understand how
>   visitors use this page. This records pages viewed, actions taken, and the campaign that
>   brought you. It does not record your name, email address or phone number.
> - **Advertising measurement** — Google Ads conversion tracking, to know which advertising
>   produced an enquiry. Where remarketing audiences are enabled, your visit may be used to
>   show you Adscade advertising on other websites.
> - **Scheduling** — Calendly, when the booking calendar is displayed.
>
> Typefaces are loaded from Google Fonts, which receives the request as an ordinary web
> request; no identifier is set by us.

### New section — analytics and advertising

> **How we measure this website**
>
> We use Google Tag Manager to load Google Analytics and Google Ads conversion measurement.
> These record events such as starting the qualification form, completing it, viewing the
> booking calendar and confirming a booking.
>
> We deliberately do **not** send your name, email address, phone number, company name or
> free-text answers to these services. Where an outcome is recorded, it is recorded as a broad
> category only.
>
> You can opt out of Google Analytics using Google's browser add-on, or by using your
> browser's tracking-protection settings.

---

## Consent

The **contact-consent checkbox is already live** and is appropriate now: it concerns
responding to an enquiry the visitor has chosen to submit, which is a distinct purpose from
analytics or advertising. It is unticked by default and is not bundled with marketing
permission.

**Analytics and advertising consent is a separate question.** Before enabling GTM, decide:

1. Whether a consent banner is required for your audience, and
2. Whether tags should be gated behind consent (Google Consent Mode v2), or
3. Whether tracking is limited to first-party measurement that does not require a banner.

This is a decision for the owner and their adviser. The page is built so that no tracking
runs until that decision is made — nothing needs to be removed, only enabled.

---

## Order of operations

1. Owner reviews and edits this draft.
2. Legal review where appropriate.
3. Update `site/privacy.html`.
4. Decide the consent approach.
5. Add the GTM container ID.
6. Verify in GTM Preview that no PII appears in any event.
7. Enable advertising conversions.

**Do not reorder these.** Steps 3 and 4 must precede step 5.
