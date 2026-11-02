# Bond tracker recovery and Supabase database checklist

The Next.js application **only reads** `public.bond_yield_snapshots` in `app/bonds.ts`. It does **not** fetch Trading Economics or schedule ingestion. The historical rows' source label may indicate a Trading Economics scraper, but the upstream collector's actual code and runtime are not committed in this repository. There are no GitHub Actions in this repository.

The reported last working date is 2026-10-24, not independently confirmed. Do not assume a frontend deployment broke ingestion.

## 1. Inspect existing data (read-only)

Run in the Supabase project's SQL Editor:

```sql
select
  country_code,
  count(*) as snapshot_count,
  max(observation_date) as latest_observation_date,
  max(fetched_at) as latest_fetched_at
from public.bond_yield_snapshots
group by country_code
order by country_code;
```

```sql
select country_code, observation_date, fetched_at, source, yields
from public.bond_yield_snapshots
where fetched_at >= timestamptz '2026-10-20 00:00:00+00'
order by fetched_at desc
limit 30;
```

Inspect the actual schema before changing it:

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'bond_yield_snapshots'
order by ordinal_position;
```

Interpretation:
- Both countries stopped inserting: investigate the shared scheduler, Edge Function, API credentials, or provider.
- One country stopped: investigate that country's endpoint, parser, and validation.
- `fetched_at` is new but `observation_date` is old: the scraper/provider may be returning stale source data; avoid inserting copies as new observations.
- Rows are current but website is stale: check Supabase RLS/select permissions, environment variables on Vercel, deployed version, and the 300-second Next.js cache.

## 2. Inspect the existing job and its invocation logs

In the Supabase Dashboard, open **Integrations > Cron** (or **Cron**, depending on UI). Find the job invoking the bond collector and inspect its status and History. These optional SQL queries work if the `pg_cron` extension is available and your SQL role can read its tables:

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobid;
```

```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where start_time >= timestamptz '2026-10-20 00:00:00+00'
order by start_time desc
limit 100;
```

A successful `pg_net` enqueue does not necessarily mean the external HTTP request or insertion succeeded.

In **Edge Functions**, inspect the bond-fetching function's **Invocations** and **Logs**, especially around October 24, 2026. Check function status codes, exceptions, vendor responses, rate limits, and database errors. If there is no function, locate the external scheduler or automation responsible for inserting the rows.

Typical causes and next steps:
- No invocations: inactive/missing cron job, wrong endpoint, or scheduler stopped.
- 401/403: invalid invocation secret or expired market-data authorization.
- 429: provider rate limit; reduce frequency and add bounded retries/backoff.
- 200 with no new rows: scraper selector/format changed, data-validation failure, failed insert, or silently ignored errors.
- SQL errors: examine table schema, `INSERT` permissions, `ON CONFLICT` constraints, and RLS.
- Identical historical observation dates: do not invent new timestamps to make them look current.

Never paste API keys, `service_role` keys, or full authorization headers into logs, issues, or chat.

## 3. Restart ingestion before modifying schema

Prefer repairing the **existing** collector first; there is already a `bond_yield_snapshots` reader. After fixing it, invoke it once manually, inspect its logs, and re-run the latest-data query above. Ensure *both* US and ID have a recent **actual** observation date, valid yields, and a recent `fetched_at`.

When using a licensed market data API or otherwise permitted provider:
1. Fetch the US and Indonesian sovereign yields for 1Y, 3Y, 5Y and 10Y.
2. Validate each numeric percentage, country, tenor, and source observation date. Reject unexpected HTML/error pages and missing data.
3. Insert/update records server-side using a Supabase secret key (not from the Next.js client).
4. Use an idempotency key such as `(country_code, observation_date)` **only if** you intentionally store one row per country per observation day. Existing databases may contain multiple fetches per day and must be inspected/migrated before adding that uniqueness constraint.
5. Log vendor status, observation date and insert success (without secrets). Add an alert when either country lacks a new market-day observation for more than four calendar days.
6. Schedule periodic execution with Supabase Cron and review run history. Avoid unnecessary high-frequency scraping. Respect provider terms and licensing.

The Next.js app already requires `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the Vercel environment. Check these settings if the database contains current rows but the site does not show them. Keep privileged database keys server-only.

## 4. For a completely new database only

**Do not execute this against the existing database without comparing schemas and data.** This example is only for creating an empty new project matching `app/bonds.ts`:

```sql
create table public.bond_yield_snapshots (
  country_code text not null check (country_code in ('US','ID')),
  country_name text not null,
  observation_date date not null,
  source text not null,
  yields jsonb not null,
  fetched_at timestamptz not null default now(),
  primary key (country_code, observation_date)
);

create index bond_yield_recent_idx
  on public.bond_yield_snapshots
  (country_code, observation_date desc, fetched_at desc);

alter table public.bond_yield_snapshots enable row level security;

create policy "Public can read bond yields"
  on public.bond_yield_snapshots
  for select
  to anon, authenticated
  using (true);
```

The `yields` JSON should look like:

```json
{"1Y": 0.0, "3Y": 0.0, "5Y": 0.0, "10Y": 0.0}
```

Those zeroes are **schema examples, not market values**. Do not insert them as observations.

Use a secure Edge Function or another server-side process to write records. If creating a new Edge Function, follow Supabase's current service-to-service authentication guidance and store secrets in Supabase Vault/project secrets. A frontend publishable key must never be treated as a privileged ingestion credential.

## 5. Verification

- Ensure the **latest observation date** is recent for both countries.
- Confirm that the **previous** yield points to an earlier distinct observation date, not a second fetch of the same date.
- Confirm the site's stale warning disappears only after genuinely recent source observations arrive.
- Confirm 10Y US, 10Y ID, and the ID-US spread use the expected units (percentage points for spread).
- Recheck the next scheduled run; a one-off successful manual invocation does not validate cron.

References:
- https://supabase.com/docs/guides/cron
- https://supabase.com/docs/guides/functions/logging
- https://supabase.com/docs/guides/functions/schedule-functions
- https://supabase.com/docs/guides/functions/auth
