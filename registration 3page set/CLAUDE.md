# Attire & Convertis — Launch Funnel

## What this repo is
A 3-page French-language launch funnel for "Attire & Convertis," a personal branding
coaching program by Elizabeth Kikumbi. Plain HTML/CSS/JS, no framework, no build step.
Deployed on Cloudflare Pages/Workers (Worker-with-static-assets pattern), assets served
from GitHub.

Pages:
- `index.html` — masterclass/webinar registration
- `merci.html` — thank-you / confirmation page
- `offre.html` — post-webinar pitch/offer page

## Stack facts (get these wrong and things break silently)
- `wrangler.toml` is **authoritative, not additive**. Every plaintext var in use must be
  explicitly listed there. Never assume a var added via the Cloudflare dashboard persists
  across a git-triggered deploy — it won't.
- This project uses a single `worker.js` at the repo root, not the `functions/api/*.js`
  folder convention (that convention is for classic Pages projects, not Worker-with-static-assets).
- KV namespaces have **no backup/undo**. Confirm dependencies before clearing or renaming one.
- All third-party library assets (CSS/JS/fonts/images) must be fully inlined (base64 where
  needed) directly into the HTML. No external CDN links, no nested subfolders — Cloudflare
  Direct Upload handles nested subfolder structures unreliably.
- Client-side code is visible via browser dev tools regardless of GitHub repo visibility.
  Never treat "the repo is private" as a security boundary for anything in the HTML/JS itself.

## Brand & copy rules (do not violate these while editing, even in code comments/placeholders)
- tu-voice throughout, never vous (except public feed posts, which aren't part of this repo)
- No em-dashes anywhere
- Say "système," never "méthode"
- No pricing anywhere in pre-webinar content (index.html, merci.html) — pricing is revealed
  live on the call only
- The program name "Attire & Convertis" never appears in pre-webinar funnel copy — use
  generic phrasing like "le webinar du [date]" instead
- No mention of a replay anywhere, at any point
- All buyers get identical content/support regardless of price paid or purchase path — never
  imply a tiered deliverable in offer copy

## Working style
- Gracia is a beginner coder building producer-level fluency. Use correct technical
  vocabulary, not dumbed down, with brief plain-language explanations woven in. She wants to
  stay an engaged, curious collaborator, not a passive bystander.
- No terminal/CLI workflows outside of Claude Code itself, and no GitHub Desktop — GitHub
  edits otherwise happen browser-only.
- Confirm before any destructive action (KV clears, schema-level changes, force pushes).

## Current task context (relaunch, Sept 9 2026 webinar — update/delete as this goes stale)
- Relaunch webinar: Wednesday, September 9, 2026. New Zoom event/instance (not reusing
  Aug 28's link or registrant data). **Zoom native registration stays OFF** — Webinars Plus
  pricing (needed for unique-link-free registration tracking at any real attendee cap) is
  not viable for this budget, and the 100-cap free trial isn't enough. Back to the original
  architecture: `index.html` is the sole registration point, one universal Zoom join link
  for everyone, no Zoom API calls, no per-registrant Zoom tracking.
- Timezone confusion (a real problem for the audience, many in Africa) gets solved by the
  **"add to calendar" block on merci.html**, not by Zoom. That block must include all 4
  calendar link options — Google, Outlook, Yahoo, and Apple (.ics) — not just one, since
  each auto-converts the event time to the person's local device time on tap. This is step
  1 of the existing 3-step flow (calendar → check email/spam → join WhatsApp).
- The "webinar's live / started 20 min ago" urgency push is a WhatsApp job, not a
  calendar/email job — one broadcast, one universal link.
- The form submit also still writes to **Brevo**, in parallel with Kit and the new Zoom
  API call. Brevo stays wired as a standby fallback list in case Kit has another
  deliverability incident — only the list/segment it writes into changes for this cohort,
  the write itself isn't being removed.
- New Kit tag for this cohort + reused welcome automation — tag ID/name: [fill in once created]
- `merci.html` needs a 3rd step added to its existing numbered flow: join the WhatsApp group
  (link: [fill in]). Current steps are (1) add to calendar, (2) check email/move from spam.
- `offre.html` checkout links: **do not wire or touch until Gracia confirms the Whop
  270€→225€ tax-display bug fix is verified live.** Re-shipping the same bug is the failure
  mode to avoid here.
- Pricing for this relaunch: 225€ total, or 2×112.50€ installments ~1 month apart.
