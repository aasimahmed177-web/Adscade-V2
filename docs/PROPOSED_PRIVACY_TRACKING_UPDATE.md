# Proposed privacy-policy amendment

> ## ⚠ OWNER / LEGAL REVIEW REQUIRED BEFORE ANALYTICS AND PRODUCTION STORAGE ACTIVATION
>
> This is a drafting aid prepared by the implementation team. It is **not legal advice** and
> must not be published as final wording without review by the owner and, where appropriate,
> a qualified adviser familiar with India's Digital Personal Data Protection Act, 2023.
>
> **Do not enable Google Tag Manager, Analytics, Ads conversion measurement or remarketing
> until the published policy reflects what is actually running.**

Version 2.0 · 31 July 2026 · concerns `site/privacy.html`

> **What changed in v2.** The qualification form was replaced by a five-field modal and the
> automatic assessment was removed entirely, so the "how we assess your enquiry" section is
> withdrawn. One correction is more important than any of that: **the phone number is now
> passed to Calendly.** The v1 draft said it was not. Publishing the v1 wording would be
> publishing a false statement about a third-party disclosure.

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

1. **Calendly** is now embedded inline on the page for every visitor who submits the form.
   The current policy describes Calendly as a page the visitor is handed to, not an embed
   loaded in-page. **Name, email address and phone number are all prefilled into it** — the
   phone travels as a Calendly custom answer.
2. **Form storage will move to Convex**, a third-party hosted database, and is **not yet
   connected**. The policy currently says submissions are "stored with our hosting and
   database provider" — that will become inaccurate in a specific way once Convex is live,
   because the data will sit with a named processor outside the website host. It also does
   not mention the hashed IP retained for rate limiting.

3. **Nothing is assessed automatically any more.** The scoring model was removed. Every
   visitor who submits valid details is offered a booking calendar, and the enquiry is
   reviewed by a person on the call. This is a *simplification* of the disclosure burden,
   not an addition — but the policy must not describe an assessment that no longer runs.

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

> Only what you submit through the enquiry form on this site:
>
> - Your name
> - Your work email address
> - Your WhatsApp or phone number
> - How many residential units you are actively marketing
> - Your current monthly advertising budget range
> - The campaign parameters in the link you arrived on (`utm_*`, `gclid`), the page address
>   and the referring page
> - Whether you are on a phone, tablet or computer
> - A one-way hashed form of your IP address, used only to limit automated submissions. The
>   hash cannot be reversed to recover your IP address.
>
> That is the whole list. We do not ask for company details, project names or budgets beyond
> the range you select, and we do not collect anything about you from other sources.

### Where it is stored — **rewrite before Convex goes live**

> Submissions are stored with Convex, a hosted database service we use as a data processor,
> and are accessible only to Adscade staff working on your enquiry. Enquiries that become
> clients are retained for the engagement and three years afterwards for tax and contractual
> records. Enquiries that do not become clients are deleted within twelve months, or sooner
> on request.
>
> We also keep a one-way hashed form of your IP address for a short period, solely to limit
> automated submissions. It cannot be reversed to identify you or your location.

### Withdrawn — "how we assess your enquiry"

**Do not publish this section.** The v1 draft described an automatic scoring process that
decided who was shown a booking calendar. That process no longer exists. Everyone who
submits the form is offered a calendar, and the enquiry is discussed with a person on the
call. There is now no automated decision-making to disclose.

### Scheduling — replace the existing section

> Once you submit the form, a Calendly booking calendar is loaded directly into the page so
> you can choose a time. Calendly is a third-party scheduling service with its own privacy
> policy. When the calendar loads, Calendly may set cookies and receives your browser's
> technical information.
>
> Your name, email address and phone number are passed to the calendar so you do not have to
> type them again. Your answers about inventory and advertising budget are **not** passed to
> Calendly. If you close the calendar without booking, no booking is created — but the
> details you submitted have already been saved to our own records.

> **⚠ Verify this against the live Calendly event before publishing.** The phone number is
> passed as a Calendly *custom answer*, which means it is stored in the Calendly booking
> record and visible to anyone with access to that Calendly account. The last sentence
> matters too: under v1 an unqualified visitor's details were stored but no calendar
> appeared, so "close the calendar without booking" left an ambiguous trail. Now the
> sequence is explicit — storage happens first, scheduling second — and the wording should
> say so plainly rather than let a visitor assume abandoning the calendar undoes the
> submission.

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
> We deliberately do **not** send your name, email address or phone number to these
> services. The events record that a step happened — that the form was opened, submitted,
> stored, or that a call was booked — and never who did it.
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

## Convex activation — a separate gate

Storage and analytics are **independent decisions** and should not be switched on together:

| Change | Requires |
|---|---|
| Convex storage live | "Where it is stored" and the revised "Scheduling" section published first |
| GTM / Analytics live | "Cookies" and "How we measure this website" published first, plus the consent decision |

Storage can go live without analytics. **Analytics must not go live without storage**, because
a conversion event with no stored lead behind it is unverifiable.

Also confirm before Convex activation:

- A data-processing position on Convex as a processor, including where data is hosted.
- The retention cron is actually scheduled, not merely specified.
- The deletion and export paths in `docs/CONVEX_LEAD_CAPTURE_SPEC.md` §10 are implemented
  and tested against a real record.

**Do not reorder these.** Steps 3 and 4 must precede step 5.
