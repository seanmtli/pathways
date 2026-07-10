alter table public.pw_cached_searches
  add column if not exists target_kind text not null default 'current_role',
  add column if not exists company_scope_key text,
  add column if not exists company_scope jsonb,
  add column if not exists sample_quality text not null default 'standard',
  add column if not exists pull_country text;

alter table public.pw_cached_searches
  drop constraint if exists pw_cached_searches_target_kind_check,
  add constraint pw_cached_searches_target_kind_check
    check (target_kind in ('current_role')),
  drop constraint if exists pw_cached_searches_sample_quality_check,
  add constraint pw_cached_searches_sample_quality_check
    check (sample_quality in ('standard', 'small'));

create index if not exists pw_cached_searches_scope_lookup_idx
  on public.pw_cached_searches
    (target_kind, title_family, industry_context, company_scope_key, refreshed_at desc);
