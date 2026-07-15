-- Freezes the first valid parse of a given query so identical queries stay
-- consistent (same canonical key, same scope) and never trigger a duplicate
-- paid pull from parser drift. parser_version invalidates the whole memo when
-- the parse prompt/logic changes.
create table if not exists public.pw_parse_memo (
  normalized_query text not null,
  parser_version text not null,
  parse_result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (normalized_query, parser_version)
);

alter table public.pw_parse_memo enable row level security;

create index if not exists pw_parse_memo_fresh_idx
  on public.pw_parse_memo (normalized_query, parser_version, created_at desc);
