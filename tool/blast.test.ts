// Running BLAST+ and reading its table into the hits the engine takes, as
// mycomap.org reads them from BLAST XML: hits in BLAST's order, identity and
// coverage from each hit's first HSP, the title without the id.
//   node --import tsx --test tool/blast.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BLAST_COLUMNS, blastnArgs, blastVersion, findBlastn, isBlastNewEnough, readBlastTable, searchWithBlastn, type ProgramRun } from "./blast";
import { InputError } from "./fasta";

const row = (cells: Record<string, string | number>) => BLAST_COLUMNS.map((c) => String(cells[c] ?? "")).join("\t");
const base = { qlen: 600, slen: 610, qseq: "ACGT", sseq: "ACGT" };

test("each query's hits come in BLAST's order, numbered from 1; a second HSP of a subject joins its hit; identity and coverage are the first HSP's", () => {
  const text = [
    row({ ...base, qseqid: "q1", sseqid: "MM10", saccver: "MM10", length: 600, nident: 594, qstart: 1, qend: 600, sstart: 5, send: 604, stitle: "Russula emetica" }),
    row({ ...base, qseqid: "q1", sseqid: "MM11", saccver: "MM11", length: 500, nident: 500, qstart: 51, qend: 550, sstart: 1, send: 500, stitle: "MM11 Russula betularum" }),
    row({ ...base, qseqid: "q1", sseqid: "MM10", saccver: "MM10", length: 40, nident: 30, qstart: 560, qend: 599, sstart: 700, send: 661, stitle: "Russula emetica" }),
    row({ ...base, qseqid: "q2", sseqid: "gb|KF932958.1|", saccver: "KF932958.1", length: 300, nident: 297, qstart: 300, qend: 1, sstart: 1, send: 300, qlen: 300, stitle: "Penicillium colei isolate NRRL 13013\tITS" }),
  ].join("\n");
  const results = readBlastTable(text, new Map([["q1", 600], ["q2", 300], ["q3", 420]]));
  const q1 = results.get("q1")!;
  assert.deepEqual(q1.hits.map((h) => [h.num, h.accession, h.def, h.hsps.length]), [[1, "MM10", "Russula emetica", 2], [2, "MM11", "Russula betularum", 1]]);
  assert.equal(q1.hits[0].identity, 99);
  assert.equal(q1.hits[1].queryCoverage, (500 / 600) * 100);
  assert.deepEqual(q1.hits[0].hsps[1], { identity: 30, alignLen: 40, queryFrom: 560, queryTo: 599, hitFrom: 700, hitTo: 661, qseq: "ACGT", hseq: "ACGT", midline: "" });
  const q2 = results.get("q2")!;
  assert.equal(q2.hits[0].id, "gb|KF932958.1|");
  assert.equal(q2.hits[0].def, "Penicillium colei isolate NRRL 13013\tITS", "a tab inside the title is kept");
  assert.equal(q2.hits[0].queryCoverage, 100, "a hit on the other strand still covers its length");
  assert.deepEqual(results.get("q3"), { queryLen: 420, hits: [] }, "a query with no hits keeps its length");
});

test("a line with too few columns stops the read, rather than giving hits with missing values", () => {
  assert.throws(() => readBlastTable("q1\tMM1\t100\n", new Map()), /3 columns, not 14/);
});

test("blastn is asked for 50 hits per sequence, as MycoBLAST asks, with the columns the reader expects", () => {
  const args = blastnArgs({ query: "q.fasta", databases: ["ncbi/genbank_its", "ncbi/refseq_its"], out: "hits.tsv", threads: 4 });
  assert.deepEqual(args.slice(0, 8), ["-query", "q.fasta", "-db", "ncbi/genbank_its ncbi/refseq_its", "-max_target_seqs", "50", "-num_threads", "4"]);
  assert.equal(args[9], `6 ${BLAST_COLUMNS.join(" ")}`);
});

test("BLAST+ 2.12 or newer is needed, to read MycoMap's v5 database and the weekly NCBI one", () => {
  assert.deepEqual(blastVersion("blastn: 2.17.0+\n Package: blast 2.17.0, build"), [2, 17, 0]);
  assert.equal(blastVersion("command not found"), null);
  assert.equal(isBlastNewEnough([2, 12, 0]), true);
  assert.equal(isBlastNewEnough([3, 0, 0]), true);
  assert.equal(isBlastNewEnough([2, 11, 9]), false);
  assert.equal(isBlastNewEnough([2, 6, 0]), false);
});

const answering = (answer: Partial<ProgramRun>) => async (): Promise<ProgramRun> => ({ code: 0, stdout: "", stderr: "", ...answer });

test("no BLAST+, or one too old, is refused with where to get it", async () => {
  await assert.rejects(findBlastn(null, answering({ code: null, startError: "spawn blastn ENOENT" })), (e: unknown) => e instanceof InputError && /not found \(blastn is not on your PATH\)\. Install BLAST\+/.test(e.message));
  await assert.rejects(findBlastn("C:/blast/bin", answering({ code: null, startError: "ENOENT" })), /not found in C:\/blast\/bin/);
  await assert.rejects(findBlastn(null, answering({ stdout: "blastn: 2.6.0+" })), /BLAST\+ 2\.6\.0 is too old/);
  assert.deepEqual(await findBlastn("C:/blast/bin/", answering({ stdout: "blastn: 2.17.0+" })), { blastn: "C:/blast/bin/blastn", blastdbcmd: "C:/blast/bin/blastdbcmd", version: "2.17.0" });
});

test("a failed search says what BLAST said, without its warnings", async () => {
  await assert.rejects(
    searchWithBlastn("blastn", [], "MycoMap's database", answering({ code: 2, stderr: "Warning: [blastn] Examining 5 or more matches is recommended\nBLAST Database error: No alias or index file found for nucleotide database [mycomap]\n" })),
    (e: unknown) => e instanceof InputError && e.message === "BLAST could not search MycoMap's database: BLAST Database error: No alias or index file found for nucleotide database [mycomap]",
  );
});
