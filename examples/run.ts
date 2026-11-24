// Runs one example on one input file:
//
//   pnpm example <example> [input]
//
// <example> is one of the names below. [input] is a file in examples/inputs/
// (with or without its extension), or a path to a file of your own; without it
// the example's first input is used. Anything after is passed to the example
// (name-a-specimen takes --identity plain).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adjustedIdentityExample } from "./adjusted-identity";
import { checkNames } from "./check-names";
import { nameASpecimen } from "./name-a-specimen";
import { visionExample } from "./vision-and-dna";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Every run the README shows: each example on each of its inputs, and the runs with arguments. */
export function exampleRuns(): Array<{ example: string; input: string; args: string[]; key: string }> {
  return Object.entries(EXAMPLES).flatMap(([example, e]) => [
    ...e.inputs.map((input) => ({ input, args: [] as string[] })),
    ...(e.alsoRun ?? []),
  ].map(({ input, args }) => ({ example, input, args, key: [example, input, ...args].join(" ") })));
}

export interface Example {
  what: string;
  /** The input files that come with it, in examples/inputs. */
  inputs: string[];
  /** Runs with arguments, as the README shows them. */
  alsoRun?: Array<{ input: string; args: string[] }>;
  run: (text: string, args: string[]) => string | Promise<string>;
}

export const EXAMPLES: Record<string, Example> = {
  "name-a-specimen": {
    what: "what the DNA says a specimen is, from its BLAST hits",
    inputs: ["russula-emetica.json", "mould-on-a-russula.json", "two-close-species.json", "genbank-only.json", "specimen-switch.json", "trametes-nanopore.json"],
    alsoRun: [{ input: "trametes-nanopore.json", args: ["--identity", "plain"] }],
    run: (text, args) => nameASpecimen(JSON.parse(text), args),
  },
  "vision-and-dna": {
    what: "whether MycoMap Vision's answer from the photos backs the DNA's name",
    inputs: ["vision-agrees.json", "vision-says-another-genus.json"],
    run: (text) => visionExample(JSON.parse(text)),
  },
  "check-names": {
    what: "how the rules read names: which reach species, which are provisional, which name no taxon",
    inputs: ["names.txt"],
    run: (text) => checkNames(text),
  },
  "adjusted-identity": {
    what: "the identity of two aligned sequences, as the rules count it",
    inputs: ["alignment.txt"],
    run: (text) => adjustedIdentityExample(text),
  },
};

function inputPath(example: string, given: string | undefined): string {
  const name = given ?? EXAMPLES[example].inputs[0];
  for (const candidate of [name, path.join(here, "inputs", name), ...[".json", ".txt"].map((ext) => path.join(here, "inputs", name + ext))]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`No input file "${name}". The ones that come with it: ${EXAMPLES[example].inputs.join(", ")}`);
}

async function main(): Promise<number> {
  const [example, ...rest] = process.argv.slice(2);
  const given = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
  const args = given ? rest.slice(1) : rest;
  if (!example || !EXAMPLES[example]) {
    console.log("Usage: pnpm example <example> [input] [options]\n\nExamples:");
    for (const [name, e] of Object.entries(EXAMPLES)) console.log(`  ${name.padEnd(18)} ${e.what}\n  ${"".padEnd(18)} inputs: ${e.inputs.join(", ")}`);
    return example ? 1 : 0;
  }
  const file = inputPath(example, given);
  console.log(await EXAMPLES[example].run(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n"), args));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
