// Backfill: reorder every cached cluster's members so the most representative
// people lead (pass 2c). Deliberately does NOT recluster — archetypes,
// percentages, and membership are untouched, so already-reviewed output stays
// stable. Vendor cost: zero. Run: npm run rank
//
// Idempotent: re-running just re-selects exemplars from the same members.

import { rankAllExemplars, type Cluster } from "../lib/clustering.ts";
import { supabase } from "../lib/db.ts";

interface Row {
  canonical_key: string;
  role_description: string;
  clusters: Cluster[];
}

const { data, error } = await supabase
  .from("pw_cached_searches")
  .select("canonical_key, role_description, clusters")
  .order("refreshed_at", { ascending: false });
if (error) throw new Error(error.message);

const rows = (data ?? []) as Row[];
console.log(`Ranking exemplars for ${rows.length} cached roles…\n`);

let ok = 0;
let failed = 0;

for (const [i, row] of rows.entries()) {
  const t0 = Date.now();
  try {
    const before = row.clusters.map((c) => c.members[0]?.name ?? "—");
    const ranked = await rankAllExemplars(row.role_description, row.clusters, (m) => console.log(`    · ${m}`));

    // Safety: membership must be identical, only the order may change.
    for (const [j, c] of ranked.entries()) {
      const a = new Set(c.members.map((p) => p.id));
      const b = new Set(row.clusters[j].members.map((p) => p.id));
      if (a.size !== b.size || [...a].some((id) => !b.has(id))) {
        throw new Error(`membership changed for cluster "${c.archetype.label}"`);
      }
    }

    const { error: writeErr } = await supabase
      .from("pw_cached_searches")
      .update({ clusters: ranked })
      .eq("canonical_key", row.canonical_key);
    if (writeErr) throw new Error(writeErr.message);

    const changed = ranked.filter((c, j) => (c.members[0]?.name ?? "—") !== before[j]).length;
    console.log(
      `${i + 1}/${rows.length} OK ${row.role_description} · ${ranked.length} clusters · ` +
        `${changed} lead example(s) changed · ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    );
    ok++;
  } catch (err) {
    console.log(`${i + 1}/${rows.length} FAILED ${row.canonical_key}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nDONE · ok=${ok} failed=${failed}`);
