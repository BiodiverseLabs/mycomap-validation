import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideRunContaminantTrash, readsDisagree,
  recordHasFlaggedRead,
  visionPickedFlaggedRead,
  visionPickedFlaggedReadReason,
  growthFormOf,
  mainReadsByRun,
  runKeyOf,
  pickReadByVision,
  runMateNameKey,
  type RunReadRow,
  type RunTrashDecision,
  type RunTrashInput,
  type RunTrashSequence,
} from "../src/runContaminantTrash";
import { placeName, type TaxonRow } from "../src/autovalidationTaxonomy";
import type { V2Vision } from "../src/autovalidationVisionSupport";

// A record raised on 2026-10-23: iNat 111673120, Morchella importuna,
// Run157_5710 plate 10 cell 53. Seq 852193 is the morel (RiC 100); 852189-92
// are Collybiopsis subnuda, flagged non-target by v1.1, and a Collybiopsis
// subnuda specimen is the main read of a well on run 157 under the other
// summary name (Run157_ITSnew plate 04 cell 53).

const lookup = new Map<string, TaxonRow>([
  ["morchella", { kingdom: "Fungi", order: "Pezizales", family: "Morchellaceae" }],
  // Keyed by canonical genus: v2's synonym table reads Collybiopsis as Gymnopus.
  ["gymnopus", { kingdom: "Fungi", order: "Agaricales", family: "Omphalotaceae" }],
  ["echinoderma", { kingdom: "Fungi", order: "Agaricales", family: "Agaricaceae" }],
  ["trichoderma", { kingdom: "Fungi", order: "Hypocreales", family: "Hypocreaceae" }],
  ["cystobasidium", { kingdom: "Fungi", order: "Cystobasidiales", family: "Cystobasidiaceae" }],
  ["hypomyces", { kingdom: "Fungi", order: "Hypocreales", family: "Hypocreaceae" }],
  ["lactarius", { kingdom: "Fungi", order: "Russulales", family: "Russulaceae" }],
  ["russula", { kingdom: "Fungi", order: "Russulales", family: "Russulaceae" }],
  ["scleroderma", { kingdom: "Fungi", order: "Boletales", family: "Sclerodermataceae" }],
  ["pseudoboletus", { kingdom: "Fungi", order: "Boletales", family: "Boletaceae" }],
  ["tulasnella", { kingdom: "Fungi", order: "Cantharellales", family: "Tulasnellaceae" }],
  ["xylaria", { kingdom: "Fungi", order: "Xylariales", family: "Xylariaceae" }],
  ["mycena", { kingdom: "Fungi", order: "Agaricales", family: "Mycenaceae" }],
  ["hyaloscypha", { kingdom: "Fungi", order: "Helotiales", family: "Hyaloscyphaceae" }],
  ["neolentinus", { kingdom: "Fungi", order: "Gloeophyllales", family: "Gloeophyllaceae" }],
  ["peniophora", { kingdom: "Fungi", order: "Russulales", family: "Peniophoraceae" }],
  ["gloeoporus", { kingdom: "Fungi", order: "Polyporales", family: "Meruliaceae" }],
  ["phlebia", { kingdom: "Fungi", order: "Polyporales", family: "Meruliaceae" }],
  ["ischnoderma", { kingdom: "Fungi", order: "Polyporales", family: "Fomitopsidaceae" }],
  ["chlorociboria", { kingdom: "Fungi", order: "Helotiales", family: "Chlorociboriaceae" }],
  ["trametes", { kingdom: "Fungi", order: "Polyporales", family: "Polyporaceae" }],
  ["agaricus", { kingdom: "Fungi", order: "Agaricales", family: "Agaricaceae" }],
  ["cortinarius", { kingdom: "Fungi", order: "Agaricales", family: "Cortinariaceae" }],
]);

function vision(genera: Array<[string, number]>, families: Array<[string, number]>, state: V2Vision["state"] = "ok"): V2Vision {
  return {
    state,
    runId: 42,
    modelVersion: "m1",
    answersVersion: "a1",
    answeredAt: "2026-10-25T00:00:00Z",
    families: families.map(([name, confidence]) => ({ name, confidence })),
    genera: genera.map(([name, confidence]) => ({ name, confidence })),
    species: [],
  };
}

const MORCHELLA_VISION = vision([["Morchella", 1], ["Verpa", 0]], [["Morchellaceae", 1], ["Pezizaceae", 0]]);

function seq(id: string, finalSpecies: string, ric: number, extra: Partial<RunTrashSequence> = {}): RunTrashSequence {
  return {
    id,
    categoryId: 168,
    flags: finalSpecies.startsWith("Non-Target:") ? { contaminant: true } : null,
    ric,
    isChild: false,
    hasChildren: false,
    analysisOwn: true,
    finalSpecies,
    flaggedNonTarget: finalSpecies.startsWith("Non-Target:"),
    runName: "Run157_5710_ITSnew_Summary",
    plate: "10",
    cell: "53",
    ...extra,
  };
}

function mateRow(id: string, observation: string, finalSpecies: string, ric: number, extra: Partial<RunReadRow> = {}): RunReadRow {
  return {
    id, observation, runName: "Run157_ITSnew_Summary", plate: "04", cell: "53", ric, categoryId: 168, flags: null,
    finalSpecies, flaggedNonTarget: false, analysisOwn: true, ...extra,
  };
}

const COLLYBIOPSIS_SPECIMEN = mateRow("824100", "inat:379566134", "Collybiopsis subnuda", 117);

function morchellaInput(overrides: Partial<RunTrashInput> = {}, sequences?: RunTrashSequence[]): RunTrashInput {
  return {
    platform: "inat",
    observationId: "111673120",
    recordName: "Morchella importuna",
    sequences: sequences ?? [
      seq("852189", "Non-Target: Collybiopsis subnuda", 100),
      seq("852192", "Non-Target: Collybiopsis subnuda", 3),
      seq("852193", "Morchella importuna", 100),
    ],
    vision: MORCHELLA_VISION,
    lookup,
    runMates: mainReadsByRun([COLLYBIOPSIS_SPECIMEN]),
    ...overrides,
  };
}

const reasonOf = (d: RunTrashDecision | undefined) => (d?.action === "keep" ? d.reason : d?.action);
const byId = (decisions: ReturnType<typeof decideRunContaminantTrash>) => new Map(decisions.map((d) => [d.sequenceId, d]));

// ── Vision picks, whatever the read counts (2026-11-06) ──────────────

const reads = (...list: Array<[string, string, number]>) => list.map(([id, name, ric]) => seq(id, name, ric));
const GLOEOPORUS = vision([["Gloeoporus", 0.7492], ["Leptodontidium", 0.0583]], [["Irpicaceae", 0.7871], ["Leptodontidiaceae", 0.0612]]);

test("Vision picks the read it shows, and the other macrofungus goes to the trash", () => {
  const decisions = byId(decideRunContaminantTrash(morchellaInput()));
  const d = decisions.get("852189")!;
  assert.equal(d.action, "trash");
  assert.equal(decisions.get("852192")!.action, "trash");
  assert.equal(decisions.has("852193"), false, "the kept read is never listed");
  if (d.action !== "trash") return;
  assert.equal(d.evidence.trigger, "flagged");
  assert.equal(d.evidence.onTarget.sequenceId, "852193");
  assert.equal(d.evidence.run.key, "run157");
  assert.equal(d.evidence.geometry, "same_cell_other_plate");
});

test("off-target reads commonly have as many reads as the record's own: equal counts make no difference (inat:371110229)", () => {
  const input = morchellaInput({ vision: vision([["Agaricus", 1]], [["Agaricaceae", 1]]), recordName: "Agaricus xanthodermus" },
    reads(["1", "Agaricus xanthodermus", 100], ["2", "Mycena galericulata", 100]));
  assert.equal(pickReadByVision(input).state, "picked");
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "trash");
});

test("the read Vision shows wins even with fewer reads, as the person chose on inat:393624868", () => {
  const input = morchellaInput({ vision: vision([["Russula", 1]], [["Russulaceae", 1]]), recordName: "Russula sp. 'IN89'" },
    reads(["1", "Russula sp. 'IN89'", 73], ["2", "Cortinarius violaceus", 100]));
  const d = byId(decideRunContaminantTrash(input));
  assert.equal(reasonOf(d.get("2")), "trash");
  assert.equal(d.has("1"), false);
});

test("the observer's name plays no part: named Peniophora, Vision on Gloeoporus, Ischnoderma goes (inat:405593374)", () => {
  const input = morchellaInput({ vision: GLOEOPORUS, recordName: "Peniophora albobadia" },
    reads(["859183", "Gloeoporus sp. 'dichrous-IN01'", 200], ["859184", "Ischnoderma resinosum", 23]));
  const d = byId(decideRunContaminantTrash(input));
  assert.equal(reasonOf(d.get("859184")), "trash");
  assert.equal(d.has("859183"), false);
});

test("named only Fungi, and with no other well on the run, the Trametes still goes (inat:405972883)", () => {
  for (const recordName of ["Fungi", null]) {
    const input = morchellaInput({ vision: vision([["Chlorociboria", 0.994]], [["Chlorociboriaceae", 0.994]]), recordName, runMates: new Map() },
      reads(["858949", "Chlorociboria aeruginascens", 100], ["858953", "Trametes gibbosa", 14], ["858954", "Trametes gibbosa", 4]));
    const d = byId(decideRunContaminantTrash(input));
    const t = d.get("858953")!;
    assert.equal(t.action, "trash", String(recordName));
    if (t.action === "trash") {
      assert.equal(t.evidence.geometry, "no_run_mate");
      assert.equal(t.evidence.trigger, "vision_pick");
    }
    assert.equal(reasonOf(d.get("858954")), "trash");
  }
});

test("with no Vision answer every read waits, so the second pass can decide it", () => {
  const input = morchellaInput({ vision: vision([], [], "no_answer") });
  assert.equal(pickReadByVision(input).state, "no_answer");
  for (const d of decideRunContaminantTrash(input)) assert.equal(reasonOf(d), "vision_no_answer");
});

test("Vision showing both reads, or neither, picks nobody", () => {
  const both = morchellaInput({ vision: vision([["Morchella", 0.6], ["Collybiopsis", 0.3]], [["Morchellaceae", 0.6], ["Omphalotaceae", 0.3]]) });
  assert.equal(pickReadByVision(both).state, "no_pick");
  assert.equal(reasonOf(decideRunContaminantTrash(both)[0]), "vision_no_pick");
  const neither = morchellaInput({ vision: vision([["Mycena", 0.9]], [["Mycenaceae", 0.9]]) });
  assert.equal(pickReadByVision(neither).state, "no_pick");
});

test("only names at 10% or more as displayed count", () => {
  const at = (c: number) => morchellaInput({ vision: vision([["Morchella", c], ["Verpa", 0.4]], [["Pezizaceae", 0.5]]) });
  assert.equal(pickReadByVision(at(0.094)).state, "no_pick");
  assert.equal(pickReadByVision(at(0.096)).state, "picked");
});

test("a genus match is enough: Vision's family can differ from mycomap.org's", () => {
  const input = morchellaInput({ vision: GLOEOPORUS }, reads(["1", "Gloeoporus dichrous", 50], ["2", "Trametes gibbosa", 50]));
  const pick = pickReadByVision(input);
  assert.equal(pick.state === "picked" && pick.name, "Gloeoporus dichrous");
});

test("a family match decides when Vision lists no genus of either read", () => {
  const input = morchellaInput({ vision: vision([["Verpa", 0.9]], [["Morchellaceae", 0.9]]) });
  const pick = pickReadByVision(input);
  assert.equal(pick.state === "picked" && pick.name, "Morchella importuna");
});

test("two species of one genus can't be told apart here: a person decides", () => {
  const input = morchellaInput({ vision: vision([["Trametes", 0.9]], [["Polyporaceae", 0.9]]) },
    reads(["1", "Trametes ochracea", 200], ["2", "Trametes versicolor", 12]));
  assert.equal(pickReadByVision(input).state, "no_pick");
});

test("one name, however many reads, is nothing to decide", () => {
  const input = morchellaInput({}, reads(["1", "Morchella importuna", 100], ["2", "Morchella importuna", 3]));
  assert.equal(pickReadByVision(input).state, "one_name");
  assert.deepEqual(decideRunContaminantTrash(input), []);
});

test("a read in the kept read's family is set aside, not trashed: it may be a better name", () => {
  const input = morchellaInput({ vision: vision([["Gloeoporus", 0.9]], [["Meruliaceae", 0.9]]) },
    reads(["1", "Gloeoporus dichrous", 50], ["2", "Phlebia radiata", 50]));
  assert.equal(pickReadByVision(input).state, "picked");
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "same_family_as_kept_read");
});

test("moulds and yeasts are never trashed, only set aside", () => {
  for (const mould of ["Trichoderma viride", "Cystobasidium minutum"]) {
    const input = morchellaInput({}, reads(["1", "Morchella importuna", 100], ["2", mould, 10]));
    assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "read_not_macro", mould);
  }
});

test("macrofungi outside the Agaricomycetes and Pezizales count as macro (Xylaria)", () => {
  const input = morchellaInput({}, reads(["1", "Morchella importuna", 100], ["2", "Xylaria hypoxylon", 10]));
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "trash");
});

test("a fungus living on other fruitbodies is real biology on the specimen: read or record, it stays", () => {
  const onRead = morchellaInput({ vision: vision([["Scleroderma", 0.9]], [["Sclerodermataceae", 0.9]]), recordName: "Scleroderma citrinum" },
    reads(["1", "Scleroderma citrinum", 100], ["2", "Pseudoboletus parasiticus", 10]));
  assert.equal(reasonOf(byId(decideRunContaminantTrash(onRead)).get("2")), "read_is_mycoparasite");
  const onRecord = morchellaInput({ vision: vision([["Russula", 0.9]], [["Russulaceae", 0.9]]), recordName: "Hypomyces lactifluorum" },
    reads(["1", "Russula brevipes", 100], ["2", "Lactarius deliciosus", 10], ["3", "Mycena galericulata", 10]));
  assert.equal(reasonOf(byId(decideRunContaminantTrash(onRecord)).get("3")), "record_is_mycoparasite");
});

test("when Vision picks a microfungus, the other read may be its substrate and stays", () => {
  const input = morchellaInput({ vision: vision([["Hyaloscypha", 0.9]], [["Hyaloscyphaceae", 0.9]]), recordName: null },
    reads(["1", "Hyaloscypha daedaleae", 30], ["2", "Neolentinus lepideus", 100]));
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "kept_read_not_macro");
});

test("when Vision picks the read v1.1 flagged, nothing is trashed: a person sorts it out", () => {
  const input = morchellaInput({ vision: vision([["Gymnopus", 0.9]], [["Omphalotaceae", 0.9]]) });
  const d = byId(decideRunContaminantTrash(input));
  assert.equal(reasonOf(d.get("852193")), "kept_read_flagged");
});

test("Vision picking the read v1.1 flagged is what sends the record to a person; picking the record's read is not", () => {
  assert.equal(visionPickedFlaggedRead(pickReadByVision(morchellaInput({ vision: vision([["Gymnopus", 0.9]], [["Omphalotaceae", 0.9]]) }))), true);
  assert.equal(visionPickedFlaggedRead(pickReadByVision(morchellaInput({}))), false);
  assert.equal(visionPickedFlaggedRead({ state: "no_pick" }), false);
  assert.equal(visionPickedFlaggedRead({ state: "no_answer" }), false);
  assert.equal(visionPickedFlaggedRead({ state: "one_name" }), false);
});

test("a read marked Non-Target by its analysis or by the record store's flag makes Vision pick, even when the other reads agree", () => {
  assert.equal(recordHasFlaggedRead([{ finalSpecies: "Morchella importuna" }, { finalSpecies: "Collybiopsis subnuda", flaggedNonTarget: true }]), true);
  assert.equal(recordHasFlaggedRead([{ finalSpecies: "Morchella importuna" }, { finalSpecies: "Non-Target: Collybiopsis subnuda" }]), true);
  assert.equal(recordHasFlaggedRead([{ finalSpecies: "Morchella importuna" }, { finalSpecies: "Collybiopsis subnuda", metaNonTarget: true }]), true);
  assert.equal(recordHasFlaggedRead([{ finalSpecies: "Morchella importuna" }, { finalSpecies: "Morchella importuna", flaggedNonTarget: false, metaNonTarget: false }]), false);
  assert.equal(recordHasFlaggedRead([]), false);
});

test("the job says which read Vision picked and that a person decides", () => {
  assert.equal(
    visionPickedFlaggedReadReason({ name: "Russula purpureopallescens", sequenceIds: ["845110", "845111"] }),
    "MycoMap Vision picked Russula purpureopallescens (seq 845110, seq 845111), a read the analysis marked Non-Target. The observer's name may be the wrong one, so a person decides this record.",
  );
});

test("the kept read must reach RiC 3", () => {
  const input = morchellaInput({}, reads(["1", "Morchella importuna", 2], ["2", "Mycena galericulata", 100]));
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "kept_read_ric_low");
});

test("parent and child sequences are never trashed", () => {
  const input = morchellaInput({}, [seq("1", "Morchella importuna", 100), seq("2", "Mycena galericulata", 10, { hasChildren: true })]);
  assert.equal(reasonOf(byId(decideRunContaminantTrash(input)).get("2")), "linked_sequence");
});

test("reads that aren't live take no part: the trash, a child, an eDNA analysis under the id, a person's contaminant flag", () => {
  const skip: Array<Partial<RunTrashSequence>> = [{ categoryId: 169 }, { isChild: true }, { analysisOwn: false }, { flags: { contaminant: true } }];
  for (const extra of skip) {
    const input = morchellaInput({}, [seq("1", "Morchella importuna", 100), seq("2", "Mycena galericulata", 10, extra)]);
    assert.equal(pickReadByVision(input).state, "one_name", JSON.stringify(extra));
    assert.deepEqual(decideRunContaminantTrash(input), []);
  }
});

test("a person's wrong flag says so in the evidence, and a read Vision picks counts whatever its flag", () => {
  const input = morchellaInput({}, [seq("1", "Morchella importuna", 100, { flags: { wrong: true } }), seq("2", "Mycena galericulata", 10, { flags: { wrong: true } })]);
  const d = byId(decideRunContaminantTrash(input)).get("2")!;
  assert.equal(d.action, "trash");
  assert.equal(d.action === "trash" && d.evidence.trigger, "wrong_flag");
});

test("one run under two summary names is one run", () => {
  assert.equal(runKeyOf("Run157_ITSnew_Summary"), "run157");
  assert.equal(runKeyOf("Run157_5710_ITSnew_Summary"), "run157");
  assert.equal(runKeyOf("Run0157_Summary"), "run157");
  assert.equal(runKeyOf("Rerun013_Short"), "rerun13");
  assert.equal(runKeyOf("Run1570_Summary"), "run1570");
  assert.equal(runKeyOf("RR26_Summary"), null);
  assert.equal(runKeyOf(null), null);
});

test("name keys match across quoting styles, so a temp code finds its source well", () => {
  assert.equal(runMateNameKey("Mycena sp. 'IN10'"), runMateNameKey('Mycena "sp-IN10"'));
  assert.equal(runMateNameKey("Non-Target: Collybiopsis subnuda"), runMateNameKey("Collybiopsis subnuda"));
  assert.equal(runMateNameKey("No BLAST hits"), null);
  assert.equal(runMateNameKey("Fungi"), null);
});

test("a well's main read is its highest-RiC clean read", () => {
  const runs = mainReadsByRun([
    mateRow("1", "inat:30", "Mycena galericulata", 12),
    mateRow("2", "inat:30", "Collybiopsis subnuda", 80),
    mateRow("3", "inat:30", "Morchella importuna", 200, { categoryId: 169 }),
  ]);
  const names = [...runs.get("run157")!.keys()];
  assert.deepEqual(names, [runMateNameKey("Collybiopsis subnuda")]);
});

// A read v1.1 did not flag (2026-11-05, inat:366910735: Suillus at RiC 22 beside Cortinarius at RiC 200).
const outreadInput = (ric: number, onTargetRic = 100, extra: Partial<RunTrashInput> = {}) => morchellaInput({ vision: vision([["Morchella", 0.6]], [["Morchellaceae", 0.6]]), ...extra }, [
  seq("1", "Morchella importuna", onTargetRic),
  seq("2", "Collybiopsis subnuda", ric),
]);

test("readsDisagree looks only at unflagged reads", () => {
  assert.equal(readsDisagree([seq("1", "Morchella importuna", 100), seq("2", "Collybiopsis subnuda", 22)]), true);
  assert.equal(readsDisagree([seq("1", "Morchella importuna", 100), seq("2", "Non-Target: Collybiopsis subnuda", 3)]), false);
  assert.equal(readsDisagree([seq("1", "Morchella importuna", 100), seq("2", "Morchella importuna", 3)]), false);
});

// Vision decisive, and "wrong" flags (2026-11-05, inat:351375760).
const UNSURE_VISION = vision([["Morchella", 0.6]], [["Morchellaceae", 0.6]]);

test("readsDisagree counts wrong-flagged reads, so the run's wells get loaded for them", () => {
  assert.equal(readsDisagree([seq("1", "Morchella importuna", 100), seq("2", "Collybiopsis subnuda", 100, { flags: { wrong: true } })]), true);
  assert.equal(readsDisagree([seq("1", "Morchella importuna", 100), seq("2", "Collybiopsis subnuda", 3, { flags: { contaminant: true } })]), false);
});
