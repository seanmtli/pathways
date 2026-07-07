# Pathways — Operator Runbook

There is no admin UI in v1 (by design, PRD §3). This file is your window into
what the system is doing. Every query below has been tested against the live
database — copy, paste, run.

## Connecting

**Option A — Supabase dashboard (easiest):** open the project's *SQL Editor* at
https://supabase.com/dashboard → project `zhgiuztnmsffydyasgit` → SQL Editor,
and paste any query below.

**Option B — psql:**

```sh
psql "postgresql://postgres:[YOUR-DB-PASSWORD]@db.zhgiuztnmsffydyasgit.supabase.co:5432/postgres"
```

(The database password is in the Supabase dashboard under Project Settings →
Database. All Pathways tables are prefixed `pw_` — they share the project with
the dukesports tables.)

---

## 1. Today's Crustdata spend + headroom vs. ceiling

The ceiling is the `DAILY_CREDIT_CEILING` env var (default 300). Update the
`300` below if you've changed it.

```sql
select
  coalesce((select credits from pw_daily_spend where day = current_date), 0) as spent_today,
  300 - coalesce((select credits from pw_daily_spend where day = current_date), 0) as headroom,
  (select count(*) from pw_search_log
    where created_at::date = current_date and outcome = 'degraded') as degraded_requests_today;
```

Spend history:

```sql
select day, round(credits, 1) as credits from pw_daily_spend order by day desc limit 14;
```

## 2. Cache hit rate (last 24h / last 7d)

```sql
select
  case when created_at > now() - interval '24 hours' then 'last 24h' else 'last 7d' end as window,
  count(*) as searches,
  count(*) filter (where cache_hit) as hits,
  round(100.0 * count(*) filter (where cache_hit) / nullif(count(*), 0), 1) as hit_rate_pct
from pw_search_log
where created_at > now() - interval '7 days'
  and outcome not in ('in_progress', 'miss_in_progress')  -- exclude requests still running
group by 1 order by 1;
```

## 3. 20 most recent searches

`outcome` values: `ok`, `thin_data`, `invalid_query`, `degraded`, `error`,
`rate_limited` — plus `in_progress` / `miss_in_progress` for requests currently
running (a `miss_in_progress` older than ~5 minutes means a request died
mid-flight; it stops counting against rate limits after an hour).

```sql
select created_at, raw_query, canonical_key, cache_hit, outcome, latency_ms, session_token
from pw_search_log
order by created_at desc
limit 20;
```

What are people searching that we didn't seed? (real demand signal, PRD §11):

```sql
select raw_query, canonical_key, count(*) as times
from pw_search_log
where cache_hit = false and outcome in ('ok', 'thin_data')
  and created_at > now() - interval '7 days'
group by raw_query, canonical_key
order by times desc, max(created_at) desc;
```

## 4. Feedback entries, newest first

```sql
select created_at, canonical_key, cluster_label,
       case when thumbs_up then '👍' else '👎' end as thumb,
       comment
from pw_feedback
order by created_at desc
limit 50;
```

Thumbs by cluster (are users recognizing the clusters as true?):

```sql
select canonical_key, cluster_label,
       count(*) filter (where thumbs_up) as up,
       count(*) filter (where not thumbs_up) as down
from pw_feedback
group by canonical_key, cluster_label
order by down desc, up desc;
```

## 5. Pipeline error count by stage (last 24h)

Stages: `parse`, `fetch`, `clean`, `cluster`, `cache_write`, `pipeline`
(uncaught). One-off entries are retries doing their job; repeated entries in
the same stage mean something is actually broken.

```sql
select stage, count(*) as errors, max(created_at) as most_recent
from pw_pipeline_errors
where created_at > now() - interval '24 hours'
group by stage
order by errors desc;
```

Recent error detail:

```sql
select created_at, stage, canonical_key, left(message, 200) as message
from pw_pipeline_errors
order by created_at desc
limit 20;
```

## 6. Sessions currently rate-limited

Sessions that were refused in the last hour (limits are rolling 1-hour
windows, so these sessions stay blocked until the window slides past):

```sql
select session_token,
       count(*) as blocked_requests,
       max(created_at) as last_blocked
from pw_search_log
where outcome = 'rate_limited'
  and created_at > now() - interval '1 hour'
group by session_token
order by last_blocked desc;
```

Sessions approaching the cache-miss cap (default 5/hour):

```sql
select session_token, count(*) as misses_last_hour
from pw_search_log
where cache_hit = false
  and outcome in ('miss_in_progress', 'ok', 'thin_data', 'error')
  and created_at > now() - interval '1 hour'
group by session_token
having count(*) >= 3
order by misses_last_hour desc;
```

---

## Emergency levers

All limits are env vars on the Railway deployment — change and redeploy, no
code change needed:

| Env var | Default | What it does |
|---|---|---|
| `DAILY_CREDIT_CEILING` | 300 | Global daily Crustdata credit cap; at the ceiling the app serves cached roles only |
| `CRUSTDATA_PULL_CAP` | 400 | Max profiles per query (~0.03 credits each → ~12 credits/pull) |
| `RATE_LIMIT_SESSION_MISS_PER_HOUR` | 5 | New (paid) searches per visitor per hour |
| `RATE_LIMIT_SESSION_TOTAL_PER_HOUR` | 60 | All searches per visitor per hour (bot protection) |
| `RATE_LIMIT_IP_MISS_PER_HOUR` | 50 | Paid searches per IP per hour (kept high — campus IPs are shared) |
| `CACHE_FRESHNESS_DAYS` | 30 | How long cached results stay fresh |

**"Stop all spending right now":** set `DAILY_CREDIT_CEILING=0` and redeploy.
Cached roles keep working; nothing new is fetched.

**Force-refresh one role** (next search re-fetches and re-clusters):

```sql
delete from pw_cached_searches where canonical_key = 'chief data officer|professional sports|c-suite';
delete from pw_cached_pulls where canonical_key = 'chief data officer|professional sports|c-suite';
```
