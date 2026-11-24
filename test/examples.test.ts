// The README's worked examples are what the examples print: each example is
// run on each of its inputs (and with the arguments the README shows), and its
// output must appear in README.md as it is. When a rule change changes an
// output, the README is brought up to date in the same release.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLES, exampleRuns } from "../examples/run";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const norm = (text: string) => text.replace(/\r\n/g, "\n");
const readme = norm(fs.readFileSync(path.join(root, "README.md"), "utf8"));

for (const run of exampleRuns()) {
  test(`the README shows what "pnpm example ${[run.example, run.input.replace(/\.(json|txt)$/, ""), ...run.args].join(" ")}" prints`, async () => {
    const text = norm(fs.readFileSync(path.join(root, "examples/inputs", run.input), "utf8"));
    const output = norm(await EXAMPLES[run.example].run(text, run.args)).trimEnd();
    assert.ok(output.length > 0);
    assert.ok(readme.includes(output), `README.md does not show this output of ${run.key}:\n${output}`);
  });
}

test("every input file that comes with the examples is used by one of them", () => {
  const used = new Set(Object.values(EXAMPLES).flatMap((e) => e.inputs));
  for (const file of fs.readdirSync(path.join(root, "examples/inputs"))) assert.ok(used.has(file), `${file} is not used by any example`);
});
