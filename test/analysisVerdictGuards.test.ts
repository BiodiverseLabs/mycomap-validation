// A missing NCBI BLAST result must never become a verdict: not a lost good
// result, and not an auto-rejection. See analysisVerdictGuards.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contaminantOnlyOutcome, isAwaitingNcbiResult, mayReplaceStoredAnalysis } from "../src/analysisVerdictGuards";

const complete = { status: "complete", finalSpecies: "Amanita muscaria", finalConfidence: 92 };
const noNcbiUrl = { status: "error", errorMessage: "NCBI BLAST results required" };
const ncbiUnreadable = { status: "error", errorMessage: "Awaiting NCBI" };

test("the two analysis results that mean 'no NCBI yet' are recognised, and nothing else is", () => {
  assert.equal(isAwaitingNcbiResult(noNcbiUrl), true);
  assert.equal(isAwaitingNcbiResult(ncbiUnreadable), true);
  assert.equal(isAwaitingNcbiResult({ status: "error", errorMessage: "MycoBLAST results required" }), false);
  assert.equal(isAwaitingNcbiResult({ status: "error", errorMessage: "Failed to fetch BLAST XML" }), false);
  assert.equal(isAwaitingNcbiResult(complete), false);
  assert.equal(isAwaitingNcbiResult(null), false);
});

test("an 'awaiting NCBI' run never replaces a stored complete verdict (NCBI down, or a rerun cleared the XML)", () => {
  assert.equal(mayReplaceStoredAnalysis(complete, noNcbiUrl), false);
  assert.equal(mayReplaceStoredAnalysis(complete, ncbiUnreadable), false);
});

test("everything else is saved as before", () => {
  const newVerdict = { ...complete, finalSpecies: "Amanita pantherina" };
  assert.equal(mayReplaceStoredAnalysis(complete, newVerdict), true);
  assert.equal(mayReplaceStoredAnalysis(complete, { status: "error", errorMessage: "MycoBLAST results required" }), true);
  assert.equal(mayReplaceStoredAnalysis(null, ncbiUnreadable), true, "nothing stored: the error is the only answer");
  assert.equal(mayReplaceStoredAnalysis(ncbiUnreadable, noNcbiUrl), true);
  assert.equal(mayReplaceStoredAnalysis(noNcbiUrl, complete), true);
});

test("auto-validate rejects as contaminant-only only when every sequence was analysed", () => {
  const contaminant = { status: "complete", flaggedContaminant: true };
  assert.equal(contaminantOnlyOutcome([{ result: contaminant }, { result: contaminant }], 0), "reject");
  assert.equal(contaminantOnlyOutcome([{ result: contaminant }, { result: null }], 0), "wait", "an unanalysed sequence is not a contaminant");
  assert.equal(contaminantOnlyOutcome([{ result: null }], 0), "wait", "no results at all is never a rejection");
  assert.equal(contaminantOnlyOutcome([{ result: contaminant }, { result: complete }], 1), "continue");
});
