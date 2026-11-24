/**
 * The engine's one rule (CONTRIBUTING.md): nothing in src/ reaches outside
 * itself. No import from outside src/, no network, database, file system,
 * clock, environment or console. Whatever a rule needs is a port the caller
 * hands in, which is what lets every decision be recorded and made again.
 *
 *   node --import tsx --test test/engineReachesNothingOutside.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);
const files = readdirSync(SRC).filter((name) => name.endsWith(".ts"));
const code = (name: string) => readFileSync(new URL(name, SRC), "utf8").replace(/\r\n/g, "\n");
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the engine has files to check", () => {
  assert.ok(files.length > 10, `${files.length} files in src/`);
  assert.ok(files.includes("index.ts"));
});

test("every file in src imports only from beside it", () => {
  for (const name of files) {
    const imports = [...code(name).matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";/gms)].map((m) => m[1]);
    for (const from of imports) assert.match(from, /^\.\/[A-Za-z]+$/, `${name} imports ${from}`);
    assert.doesNotMatch(withoutComments(code(name)), /\bimport\(|\brequire\(/, `${name} loads nothing at run time`);
  }
});

const OUTSIDE: Array<[string, RegExp]> = [
  ["calls a web address", /(?<![.\w])fetch\(|\bXMLHttpRequest\b|\bWebSocket\b/g],
  ["uses the platform", /\bprocess\.|\bconsole\.|\bsetTimeout\(|\bsetInterval\(|\bBuffer\b/g],
  ["reads the clock or draws a random number", /\bDate\.now\(|\bnew Date\(\s*\)|\bMath\.random\(|\bperformance\.now\(/g],
  ["uses a node module", /["']node:|["']fs["']|["']pg["']/g],
  ["queries a database", /\.onConflictDo(?:Update|Nothing)\(|\b\w+\.db\b|\.returning\(|\bsql`/g],
];

test("no file in src uses the network, a database, files, the clock, the environment or the console", () => {
  const found: string[] = [];
  for (const name of files) {
    const lines = withoutComments(code(name)).split("\n");
    for (const [what, re] of OUTSIDE) {
      const at = lines.flatMap((line, i) => (line.match(re) ? [i + 1] : []));
      if (at.length) found.push(`${name} ${what}: ${at.length} line(s) of code, first ${lines[at[0] - 1].trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(found, [], `the engine reaches outside itself:\n  ${found.join("\n  ")}`);
});

test("the analysis is handed no key and reaches no database of its own: the eDNA tables only through the operations it is given", () => {
  const source = withoutComments(code("analysis.ts"));
  const body = source.slice(source.indexOf("export async function runDeterministicAnalysis("));
  assert.ok(body.length > 1000, "the analysis is in analysis.ts");
  assert.doesNotMatch(body, /\bapiKey\b/);
  assert.doesNotMatch(body, /(?<![.\w])db\./);
});

test("the package exports every file in src, and nothing that isn't there", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
  const exported = new Set(Object.values(pkg.exports).map((path) => path.replace(/^\.\/src\//, "")));
  for (const target of exported) assert.ok(files.includes(target), `the package exports ${target}, which is in src/`);
  const index = code("index.ts");
  for (const name of files.filter((n) => n !== "index.ts")) {
    assert.ok(exported.has(name), `${name} has its own export`);
    assert.ok(index.includes(`from "./${name.replace(/\.ts$/, "")}";`), `index.ts passes ${name} on`);
  }
});
