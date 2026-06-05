# Guest.Manager Site

Landing + auth/billing pages for Guest.Manager — AI messaging SaaS for Berlin salons. Static HTML pages backed by a Node API and Supabase. Currently in outreach phase.

## Stack

- **Frontend** — Plain HTML pages (`index.html`, `dashboard.html`, `login.html`, `onboard.html`, `billing.html`, `admin.html`, etc.)
- **Auth** — `auth.js` + Supabase auth
- **API** — `api/` (Node), Railway-hosted backend (separate from this repo for the messaging service itself)
- **DB** — Supabase, migrations in `migrations/`

## Commands

No build step — the site is static HTML loaded directly. Local preview: open the HTML in browser, or use any static server (`npx serve .`).

## Hard rules

- Customer outreach is GDPR-sensitive — no logging emails or salon details outside the Supabase table designed for it
- Impressum (`impressum.html`) is legally required in DE — don't break the link
- Stripe/billing config lives in environment, not code

## Reference

- Production domain: `guestmanager.co`
- Migrations: `migrations/` (run in order via the API)
