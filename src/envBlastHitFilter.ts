// envBLAST searches a database built from every project's eDNA variants (see
// envBlastService: each defline carries `projectId=<id>`). A caller who may
// only see some projects' eDNA data gets the result XML with every other
// project's hits removed, so a search cannot list the samples, read counts
// and sequences of projects they have no role in.

const HIT_BLOCK = /<Hit>[\s\S]*?<\/Hit>\s*/g;

// The eDNA variant id an envBLAST hit points at. The database is built with
// `makeblastdb -parse_seqids`, so blastn moves the defline's first token
// ("variant-N") into Hit_id / Hit_accession and leaves only
// "sample=… projectId=… ric=…" in Hit_def. Some parsers glue the accession
// back onto the definition, so the definition is checked last.
export function envBlastHitVariantId(hit: { id?: string | null; accession?: string | null; def?: string | null }): string | null {
  for (const field of [hit.id, hit.accession]) {
    const m = (field ?? "").trim().replace(/^lcl\|/i, "").match(/^variant-(\d+)$/);
    if (m) return m[1];
  }
  return (hit.def ?? "").match(/^variant-(\d+)\b/)?.[1] ?? null;
}

function hitProjectId(hitBlock: string): number | null {
  const match = hitBlock.match(/projectId=(\d+)/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Every project named by a hit in the result.
export function envBlastHitProjectIds(xml: string): number[] {
  const ids = new Set<number>();
  for (const block of xml.match(HIT_BLOCK) ?? []) {
    const id = hitProjectId(block);
    if (id != null) ids.add(id);
  }
  return [...ids];
}

// The result with only the hits from `visibleProjectIds`. A hit that names no
// project cannot be attributed, so it is dropped too (fail closed).
export function filterEnvBlastXmlToProjects(xml: string, visibleProjectIds: Set<number>): string {
  return xml.replace(HIT_BLOCK, (block) => {
    const id = hitProjectId(block);
    return id != null && visibleProjectIds.has(id) ? block : "";
  });
}
