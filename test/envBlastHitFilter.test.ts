import assert from "node:assert/strict";
import { test } from "node:test";
import { envBlastHitProjectIds, filterEnvBlastXmlToProjects } from "../src/envBlastHitFilter";

// The shape blastn writes for the envBLAST database: deflines built by
// envBlastService carry `projectId=<id>`.
const hit = (n: number, variantId: number, projectId: number | null) => `
        <Hit>
          <Hit_num>${n}</Hit_num>
          <Hit_id>variant-${variantId}</Hit_id>
          <Hit_def>sample=S-${variantId} project=P${projectId ?? ""}${projectId != null ? ` projectId=${projectId}` : ""} seq=1 var=1 ric=12</Hit_def>
          <Hit_hsps><Hsp><Hsp_identity>200</Hsp_identity></Hsp></Hit_hsps>
        </Hit>`;
const xml = `<?xml version="1.0"?>
<BlastOutput>
  <BlastOutput_iterations>
    <Iteration>
      <Iteration_hits>${hit(1, 11, 7)}${hit(2, 12, 8)}${hit(3, 13, 7)}${hit(4, 14, null)}
      </Iteration_hits>
    </Iteration>
  </BlastOutput_iterations>
</BlastOutput>`;

test("envBLAST hits name the projects they come from", () => {
  assert.deepEqual(envBlastHitProjectIds(xml).sort(), [7, 8]);
});

test("a caller limited to some projects sees only those projects' envBLAST hits; unattributable hits are dropped", () => {
  const filtered = filterEnvBlastXmlToProjects(xml, new Set([7]));
  assert.match(filtered, /variant-11/);
  assert.match(filtered, /variant-13/);
  assert.doesNotMatch(filtered, /variant-12/, "another project's hit is removed");
  assert.doesNotMatch(filtered, /variant-14/, "a hit with no project is removed");
  assert.match(filtered, /<\/Iteration_hits>/, "the document stays well formed");
  assert.equal(filterEnvBlastXmlToProjects(xml, new Set()).includes("<Hit>"), false);
});
