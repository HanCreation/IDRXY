# IDRXY

Next.js app for an Indonesian Rupiah strength index.

## Vercel

Deploy this repository with these settings:

- Framework Preset: `Next.js`
- Root Directory: repository root
- Install Command: `npm install`
- Build Command: `npm run build`
- Output Directory: `.next`
- Optional Environment Variable: `NEXT_PUBLIC_SITE_URL=https://your-domain.example`

The homepage route is `app/page.tsx`, so `/` should resolve after a successful Next build.

## Bond collection

`supabase/functions/fetch/index.ts` is the source for the existing Supabase `fetch` Edge Function, invoked by the database's five-minute cron. Vercel reads the saved snapshots; it does not collect the bond curves. Deploy the function separately from the Next.js site, preserving its existing CRON_SECRET bearer authentication and project secrets.

Bond curves are checked hourly (or with an authenticated `force_bonds: true` request):

- US: official Daily Treasury Par Yield Curve XML, 1Y/3Y/5Y/10Y.
- Indonesia: PHEI Indonesia Government Securities Yield Curve, 1Y/3Y/5Y/10Y.

These are daily curves, not intraday Trading Economics quotes. Store each provider's observation date separately from the fetch time. The function rejects incomplete curves, bot-check pages, future observations, and observations older than seven calendar days. Failed bond writes are excluded from `rows_saved`, and any required feed failure produces a non-success HTTP response and a partial/failed `fetch_runs` record.

The site labels each provider, flags delayed collection, compares only observations from the same provider, and calculates the country spread only when the observation dates match. Historical gaps require actual dated source records; do not copy current values into missing days. Existing Trading Economics snapshots remain historical records.

Validate with `node --test tests/bond-fetch.test.cjs`, `npx tsc --noEmit`, and `npm run build`.
