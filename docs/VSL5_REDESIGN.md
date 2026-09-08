# VSL-5 Elementor redesign — 8 September 2026

The owner reported the lead-to-booking workflow working and requested a complete
visual and copy rewrite. `site/vsl-5.html` is the complete replacement HTML widget.

## Changes

- Clear opening promise: one shoot, 20 videos, every month. Buyer-focused examples,
  an explicit monthly scope and practical FAQs replace repetitive sales sections.
- Scoped forest-green/cream styling, simpler buttons, responsive editorial layouts,
  consistent spacing and typography, and deliberate image crops.
- All team sizes are welcomed. Every valid, stored application can open Calendly
  by default, including `1_4` / `no`. The backend qualification verdict still owns
  qualified conversion reporting; opening booking does not qualify every applicant.
- Dialog and mobile booking bar are moved outside Elementor's transformed wrapper.
  The dialog scrolls internally, traps keyboard focus and restores the opener.
- Visible consent errors, focused invalid fields and clearer retry feedback.
- No added results claims, testimonials, prices or invented guarantees. The existing
  content offer, separate paid-advertising scope and two editorial images remain.

## Verification

`node tools/content-ui-review.mjs` passed 213 browser assertions at widths 1440,
1024, 768, 390 and 320. The harness uses the actual widget and header in a simulated
Elementor wrapper with competing theme CSS and a transformed ancestor. Screenshots
were inspected at desktop, tablet and phone sizes with the page's fonts and images.

Checks cover layout overflow, dialog fit, every CTA, FAQs, focus handling, the sticky
bar, validation, duplicate submissions, failed-save retry with the same ID, Calendly
destination/prefill, open access, optional strict mode and qualification telemetry.
Backend, telemetry and calendar requests were intercepted. These checks verify the
frontend contract; they do not independently certify live Convex or Google Sheets.

## Install

Replace the entire existing VSL-5 Elementor HTML widget with `site/vsl-5.html`.
Keep the working page-specific header. Use a full-width, zero-padding container
and Elementor Canvas if the theme adds another header/footer around this page.
Update the page and clear the WordPress/cache-plugin cache.

No Apps Script or Convex change is needed for this redesign. WordPress publishing
is performed by the owner. The optional `ADSCADE_CONTENT_REQUIRE_QUALIFICATION`
flag must stay unset or false while booking is open to everybody.


## iPhone production clarification and image pack

The owner clarified that the base content service is shot on iPhone. The page
now says so in the hero support line, process, deliverables, package and shoot
FAQ, and the page description reflects it. The booking contract is unchanged.

The owner rejected the sample-video-cover collage. Replacement imagery consists
of an illustrative iPhone shoot, content preparation and a photo-derived founder
portrait, each with separate landscape desktop and portrait mobile compositions.
Upload-ready WebP exports are 1280x960 desktop and 768x960 mobile.

Media integration is pending the owner's six WordPress File URLs. Until then the
HTML still references the old two images; do not describe them as replaced live.
The next media change must use picture/source selection and display the full
image proportions (the prior hero's portrait crop can cut off the iPhone). Update
the header's hero preload/OG image at the same time. Add the compact founder
introduction with the owner's existing name/role and no borrowed content results.
