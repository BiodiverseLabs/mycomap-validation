// Example: what does the DNA say this specimen is?
//
//   pnpm example name-a-specimen russula-emetica
//   pnpm example name-a-specimen mould-on-a-russula
//   pnpm example name-a-specimen path/to/your-specimen.json
//   pnpm example name-a-specimen trametes-nanopore --identity plain
//
// Reads a specimen from a JSON file (examples/inputs/ has some to copy), runs
// MycoMap's analysis on its BLAST hits, and prints the name it reaches, how
// sure it is, any flags, which identity each source was judged on, and each
// step it took.
//
// --identity plain   a what-if: judge every hit on its plain identity, as if
//                    nothing were adjusted (not MycoMap's rule)
import { runDeterministicAnalysis } from "../src/analysis";
import { contaminantNameBasis } from "../src/contaminantLikelyName";
import { genbankFamilyWarning } from "../src/genbankLikelyName";
import { identityUsed, portsFromSpecimen, SPECIMEN_ID, type IdentityMode, type SpecimenInput } from "./lib/specimenInput";

const MARK: Record<string, string> = { pass: "✓", fail: "✗", skip: "–", info: "·", pending: "…", running: "…" };

/** The identity mode the arguments ask for: MycoMap's rule unless `--identity plain`. */
export function identityModeFrom(args: string[]): IdentityMode {
  const at = args.indexOf("--identity");
  if (at < 0) return "rule";
  const value = args[at + 1];
  if (value === "plain") return "plain";
  if (value === "adjusted" || value === "rule") return "rule";
  throw new Error(`--identity takes "plain" (a what-if) or "adjusted" (MycoMap's rule, the default), not "${value ?? ""}"`);
}

function describeIdentity(input: SpecimenInput, mode: IdentityMode): string[] {
  if (mode === "plain") {
    return [`Identity used: plain identity for every hit. This is a what-if: MycoMap's rules use adjusted identity.`];
  }
  const used = identityUsed(input, mode);
  const part = (label: string, c: { adjusted: number; plain: number; notCounted: number }) => {
    const bits = [
      c.adjusted && `${c.adjusted} adjusted`,
      c.plain && `${c.plain} plain (no adjusted identity given)`,
      c.notCounted && `${c.notCounted} not counted (a MycoMap hit counts only with adjusted identity)`,
    ].filter(Boolean);
    return bits.length ? `${label} ${bits.join(", ")}` : null;
  };
  const parts = [part("MycoMap", used.mycomap), part("NCBI", used.ncbi)].filter(Boolean);
  return [`Identity used: ${parts.length ? parts.join("; ") : "(no hits)"}`];
}

export async function nameASpecimen(input: SpecimenInput, args: string[] = []): Promise<string> {
  const mode = identityModeFrom(args);
  const ports = portsFromSpecimen(input, mode);
  const result = await runDeterministicAnalysis(
    ports, SPECIMEN_ID, "example:ncbi", "example:local", input.recordName, input.readCount, null, true,
  );
  const flags = [
    result.flaggedContaminant && "contaminant",
    result.flaggedNonTarget && "non-target",
    result.barcodeGapNeeded && "barcode gap check needed",
    // noBlastHits: no MycoMap (MycoBLAST) hit other than the specimen's own reads.
    result.noBlastHits && "no MycoMap hits",
  ].filter(Boolean);
  const lines = [
    ...(input.about ? [input.about, ""] : []),
    `Record name:   ${input.recordName ?? "(none)"}`,
    `Read count:    ${input.readCount ?? "(Sanger read)"}`,
    `Hits:          ${(input.mycomapHits ?? []).length} MycoMap, ${(input.ncbiHits ?? []).length} NCBI`,
    ...describeIdentity(input, mode),
    "",
    `DNA name:      ${result.finalSpecies ?? "(none)"}`,
    `Confidence:    ${result.finalConfidence === null ? "(none)" : `${result.finalConfidence}%`}`,
    `Flags:         ${flags.length ? flags.join(", ") : "none"}`,
  ];
  if (result.contaminantLikelyName) lines.push(`Likely is:     ${result.contaminantLikelyName.name ?? "(no name)"}`);
  // Only GenBank to go on: what it points to, never the DNA name (src/genbankLikelyName.ts).
  const genbank = result.genbankLikelyName;
  if (genbank) lines.push(`GenBank says:  likely ${genbank.name} (${genbank.confidence}% confidence in the name): ${contaminantNameBasis(genbank)}. Not a DNA name.`);
  const warning = genbankFamilyWarning(genbank);
  if (warning) lines.push(`Warning:       ${warning}`);
  lines.push("", "Steps:");
  for (const step of result.steps) lines.push(`  ${MARK[step.status] ?? "?"} ${step.step}: ${step.message}`);
  return lines.join("\n");
}
