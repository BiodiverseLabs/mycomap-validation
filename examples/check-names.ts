// Example: how do the rules read a name?
//
//   pnpm example check-names
//   pnpm example check-names path/to/your-names.txt
//
// One name per line. For each, says what the rules take it to be, and whether
// it is a name a record can be validated as (only a species, or a provisional
// species with its code, can be).
import { parseSpeciesName, reachesSpecies } from "../src/autovalidationNames";
import { isPlaceholderOrganismName, isUnculturedName } from "../src/speciesNames";

const READS_AS: Record<string, string> = {
  binomial: "a species",
  provisional: "a provisional species (its code in quotes)",
  genus_only: "a genus only",
  bare_sp: "a genus with no species (sp.)",
  above_genus: "a group above genus",
  verdict: "an analysis verdict, not a name",
  unparsed: "not read as a name",
  empty: "empty",
};

export function checkNames(text: string): string {
  const names = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const rows = names.map((name) => {
    const parsed = parseSpeciesName(name);
    const standIn = isUnculturedName(name) || isPlaceholderOrganismName(name);
    const reads = standIn ? "a GenBank stand-in, not a taxon" : READS_AS[parsed.kind] ?? parsed.kind;
    const ok = reachesSpecies(parsed) && !standIn ? "yes" : "no";
    return [name, reads, ok];
  });
  const header = ["Name", "Read as", "Can validate a record"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
