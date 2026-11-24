# Changelog

Every change to a rule gets its own release number. A release that leaves
every decision the same is a patch; one that changes a decision is a minor or
major release, and says here which decisions change.

## 2.0.0 (2026-11-24)

The first full release. The rules are those of MycoMap auto-validation v1.4,
unchanged, and the same code mycomap.org runs: every decision is the same as
mycomap.org's under v1.4, and the same as beta.16's.

What 2.0.0 holds, gathered from the previews below:

- **The rules:** the per-sequence analysis (names from BLAST hits, votes,
  consensus tiers, coverage, the confidence score, contaminant and non-target
  flags, adjusted identity), the cross-read passes across one record's reads,
  and the record decision (wait, leave for a person, reject, or validate as
  one species, with MycoMap Vision and the second source). Cases write down
  what a decision was asked and answered, so it can be made again from that
  alone.
- **The tool, on your own computer:** `init` downloads MycoMap's and
  GenBank's databases and BLAST+; `run` names the sequences in a FASTA file
  and decides each record as auto-validation would; `ui` does the same in
  your browser; `export` writes Darwin Core, GenBank submission and
  iNaturalist files; `contribute` sends your sequences to MycoMap.
- **Opt-in, with your own key or address:** MycoMap Vision about each
  record, and a live NCBI search (`--refresh-ncbi`) for the sequences the
  weekly GenBank database does not answer. Without them nothing is sent
  anywhere.
- **One download per computer** (Windows, macOS on Apple silicon or Intel,
  Linux on Intel or ARM), each tried on its own kind of computer before the
  release is published, and the one-line installers. Now that this
  repository is public, they need no GitHub sign-in.

**The database it runs against.** MycoMap's reference sequences and records
are rebuilt every night on mycomap.org's Data Downloads page, and a version
is archived on Zenodo each month under CC BY 4.0:
[10.5281/zenodo.24503494](https://doi.org/10.5281/zenodo.24503494) (every version). To say exactly which
sequences a result came from, cite the version you used: every result
carries the dates of the databases that made it.

Since beta.16 the code has one change: `run --refresh-ncbi` with an NCBI API
key (and "Ask NCBI live" in `ui`) checks the key once with NCBI's E-utilities
before it sends anything, and stops with NCBI's reason if NCBI does not know
the key. NCBI's BLAST takes a key it does not know without a word, then never
finishes the search, so a mistyped key left each sequence waiting the full
hour before it kept its weekly hits. Without a key nothing is checked; if NCBI cannot answer the check, the refresh goes on
and says so.

The data has two changes, neither to the rules. In the nightly names table,
an iNaturalist or Mushroom Observer copy of a read now carries that read's
contaminant, wrong-specimen and orientation flags; the tool reads them as it
reads every flag, so a flagged read no longer counts as clean evidence
through its copy. And such a copy is no longer in the BLAST database or the
reference sets when its own read, with exactly its bases, stands in for it
(about 17,000 copies), so the same read is no longer two of a sequence's
hits.

This repository starts its history at 2.0.0. The previews before it
(2.0.0-alpha.1 to 2.0.0-beta.16) were published while it was private; their
notes are kept below.

## 2.0.0-beta.16 (2026-11-20)

`contribute --status` shows a refusal's reason once: a read refused for its
record's own reason no longer repeats it, and a reason's closing full stop no
longer runs into what follows it. The release now tries every download on its
own kind of computer before anything is published: the macOS Intel and Linux
ARM zips join Windows, macOS on Apple silicon and Linux x64, each with NCBI's
BLAST+ for that computer, and a test keeps the list of tried downloads the
same as the list built. No rule changes: a patch.

## 2.0.0-beta.15 (2026-11-20)

`run --refresh-ncbi` no longer needs an NCBI API key: only your email address
(`--ncbi-email`, or `NCBI_EMAIL`), which NCBI asks for so it can tell you of a
problem. A key (`--ncbi-key`, or `NCBI_API_KEY`) is still sent if you give
one. The pace is the same either way: one request every 10 seconds and one
check a minute on each search, as NCBI asks. Without a key nothing of one is
sent, and a refusal no longer tells you to check a key you never gave. In
`ui`, the key box may be left empty. No rule changes: a patch.

## 2.0.0-beta.14 (2026-11-20)

Fixed: on Windows, `init` could stop with "EPERM: operation not permitted,
rename" as it put a newly unpacked database in place, when a virus scanner
still had one of its new files open (beta.13's first release run met it on
GitHub's Windows machine). The unpacking now waits until each file is closed,
and init tries the rename again for a few seconds, then says in words to run
the command again (what is downloaded is kept). Also fixed: a test of the
release tooling that read a Windows path wrongly on Linux. beta.13's
installers and zips were never attached to its release; this release has them.
No rule changes: a patch.

## 2.0.0-beta.13 (2026-11-20)

Phase 5 of the tool, and its install. Everything that reaches the internet
is opt-in: without it nothing is sent anywhere, as before.

- **Install with one line**, no administrator needed:
  `irm …/install.ps1 | iex` in Windows PowerShell, or `curl -fsSL
  …/install.sh | sh` on macOS and Linux, from the release's own files. Each
  downloads the zip for your computer (Node.js inside), refuses it unless
  its SHA-256 matches, puts `mycomap-validation` and `mmv` on your own PATH,
  and runs `init`. The zips are also attached to each release. While this
  repository is private, the release files need a GitHub sign-in.
- **MycoMap Vision in the record decisions.** With a Vision key
  (`--vision-key` or `MYCOMAP_VISION_KEY`, requested through mycomap.org's
  key manager), the tool asks MycoMap Vision's public API about each record:
  an iNaturalist or Mushroom Observer record by its observation number, any
  other by the photos in the folder the sheet's `photos` column names. The
  answer goes to the engine's own Vision rules, so agreement can validate a
  record below 70%, a genus veto holds one, Vision can be the second source,
  and Vision picks between reads that disagree, as on mycomap.org. Reads it
  sets aside are reported, never moved. In the browser app: "Ask MycoMap
  Vision".
- **NCBI live: `run --refresh-ncbi`.** With your own NCBI API key and email
  address, the sequences with no weekly GenBank hit at 97% or better are
  searched on NCBI's BLAST as mycomap.org searches them, within NCBI's
  guidelines. The results say "NCBI: live <date>" for those sequences.
- **`export <run folder>`:** a run's validated records as Darwin Core,
  GenBank submission files for NCBI's Submission Portal (in the shape
  mycomap.org writes them) and iNaturalist fields and comment to paste, with
  a report of what each record still lacks. The records sheet gains optional
  columns for the collection facts these need.
- **`contribute <run folder>`:** sends a run's sequences to MycoMap with your
  mycomap.org member key (`--key` or `MYCOMAP_MEMBER_KEY`; an admin grants it
  the right to contribute), after showing what will be sent and asking you to
  agree to CC BY 4.0. MycoMap checks and reviews each contribution, and runs
  its own analysis: nothing you send is a validation. `--status` follows it
  and swaps a local name (`Genus sp. 'local-<read>'`) for the MycoMap name it
  is given; `--withdraw` takes it back before a decision. A local name is
  never exported. In the browser app: Contribute.

A run folder now keeps its input files and the cleaned sequences
(`sequences.fasta`).

No rule changes: a patch.

## 2.0.0-beta.12 (2026-11-20)

The tool in your browser: `pnpm tool ui` starts a small web server on your
own computer (127.0.0.1 only) and opens one page. Choose a FASTA file and a
records sheet; follow the run's progress; read the records with their
decisions and every sequence, and open a sequence for each step the rules
took and its best hits; save the same files `run` writes. Each run is kept
in its own folder under the data folder and listed under Past runs. The
page loads nothing from the internet, and the server answers only
localhost addresses and only requests carrying the page's own key, so
another website open in the browser cannot start a run or read the
results. The README shows it, with two screenshots.

No rule changes: a patch.

## 2.0.0-beta.11 (2026-11-20)

`run` now decides each record as mycomap.org's auto-validation does: validate
it as the DNA's species, reject it, or hold it for a person, with the reason
in a sentence. The engine's own decideRecord makes the decision; the tool
answers its questions from the run (the reads grouped by the records sheet's
record column, the sheet's name as the observer's identification, each
read's read count, the names table's families). MycoMap Vision is not asked
yet, so a record is decided as one whose photos Vision could not use: the
observer's identification is the only second source. Written to records.csv
(one row per record) and results.json. On 15 records mycomap.org had
decided, the tool agreed on 4 (three validated as the same species, one
rejected) and held 11: 7 mycomap.org validated with Vision's help, 3 a person
validated, 1 people rejected.

No rule changes: a patch.

## 2.0.0-beta.10 (2026-11-20)

The tool's answers are brought closer to mycomap.org's. Compared on 30
sequences mycomap.org had analysed, the same name and flags came out for 27
before and after; the same confidence for 14 before and 18 after, most of the
rest within a few points. What is left comes from the evidence: GenBank's
weekly database returns other top hits than mycomap.org's GenBank search, and
the nightly MycoMap database is not quite MycoBLAST's.

- A MycoMap hit counts when the sequence or its observation is verified, as on
  mycomap.org. The names table's new `validation` column says so (an older
  table falls back to `on_validated_record`, which leaves out the other reads
  of a validated specimen: 26 of 45 hits on one Cantharellus).
- A sequence that is one of MycoMap's own (its FASTA id is MM123, or 123) no
  longer counts its own read, or its specimen's other reads, as support for
  itself.
- The records sheet takes a `record` column: sequences that share one are one
  record's reads, so the low read count penalty is no longer waived for every
  sequence as if it were its record's only one.
- "[]", how MycoMap's records write an empty flag list, is no longer read as a flag.

No rule changes: a patch.

## 2.0.0-beta.9 (2026-11-20)

Fixed: an archive cut short in the middle of a large file left that file half
written, and a write still queued could fail afterwards (beta.8's CI failed
on Linux this way). The unpacking now lets the queued writes finish and
removes the part written. init checks each download's checksum before
unpacking it, so a cut-short download never reached this. No rule changes:
a patch.

## 2.0.0-beta.8 (2026-11-20)

The tool sets itself up: `pnpm tool init` downloads MycoMap's nightly BLAST
database and names table, GenBank's weekly fungal ITS database and BLAST+
2.17.0 for your computer, checks each file against its published checksum
(BLAST+'s are pinned in the code), and unpacks them into the data folder. It
says what it will download, and how big it is, and asks before it starts.
Run again, it downloads only what changed; a broken download carries on
where it stopped; a file that is not the published one is refused. A
computer with no internet is set up from a folder made with
`init --download-only` on one that has it (`init --from`). `run` uses the
BLAST+ init installed, and its results say which BLAST+ ran.

Fixed: BLAST+ reports its use to NCBI unless told not to, so in 2.0.0-beta.7
a `run` sent NCBI BLAST+'s usage report although the README says nothing is
sent anywhere. Every BLAST+ program the tool starts is now told not to
(BLAST_USAGE_REPORT=false; its trace log then says "Phone home disabled").

No rule changes: a patch.

## 2.0.0-beta.7 (2026-11-20)

The first part of the command-line tool: `pnpm tool run my-sequences.fasta`
names each sequence in a FASTA file on your own computer. It searches
MycoMap's nightly BLAST database, and GenBank's weekly fungal ITS database if
it has been downloaded, with your own BLAST+ (2.12 or newer). It works out
adjusted identity for every hit, reads each MycoMap hit's record and each
genus's family from the names table, and runs the same analysis mycomap.org
runs. A sheet of records (`--records`) gives each sequence the identification
to check it against. It writes results.csv (one row per sequence) and
results.json (every step), stamped with the engine version and the database
dates. Its tests search a small database with the real blastn.

No rule changes: a patch.

## 2.0.0-beta.6 (2026-11-20)

Adjusted identity now also gives the package's annotated score string: one
mark per column of the alignment, saying how it was counted (| the same
base, = a run-length difference or an ambiguity code set aside, a space for
a real difference, - a gap column already counted, . not compared).
scoreAlignmentAnnotated returns it beside the same score as scoreAlignment.
It gives the package's own strings on every test vector, and on 5,000
generated alignments with homopolymers, repeats, ambiguity codes, gaps and
ragged ends. mycomap.org's BLAST pages, MycoBLAST and eDNA uploads now score
adjusted identity with this code instead of the Python package, so the site
works out adjusted identity in one place. Worked example 8 shows the marks.

No score changes: a patch.

## 2.0.0-beta.5 (2026-11-19)

An existing species is offered before a new provisional name. A record
nothing validated names was offered a new name, its base voted only at
genus, family or order, even when GenBank already named the species: one
Hydnellum record had 7 of 8 GenBank records Hydnellum mirabile at 99.5% or
more, and 2 of its 3 unvalidated MycoMap neighbours carried the same name,
yet it was offered "Hydnellum sp. 'WA01'".

existingSpeciesName (newNameSuggestion.ts) now offers GenBank's species
instead when all of these hold: GenBank's likely name is a species from at
least two records; that species holds more than half the identity weight of
the closest hits that name a species; the cluster's unvalidated MycoMap
records do not mostly carry another species; no hit carrying the name sits
below 98.5%; and its family is not another from the record's. It says when
the closest other species is within 0.1% (here Hydnellum aurantiacum at
99.52% against 99.57%), so a person can judge how well the barcode
separates them. Otherwise the new name is made as before. A person still
applies the name; nothing that decides changes: a patch.

## 2.0.0-beta.4 (2026-11-19)

GenBank's likely name now says when it is in another family from the record.
With no DNA name the analysis never compares families with the record, so a
specimen switch or a read of something else that only GenBank matches was
not caught, and its GenBank likely name could read like a suggestion for the
record. The likely name now carries the family of its genus and the record's
(`likelyFamily`, `recordFamily`, `familyDiffers`), and a warning goes with it
when they differ: "GenBank points to Hyaloscyphaceae; the record is
Fomitopsidaceae: possibly a specimen switch or an off-target read." When the
genus's family cannot be looked up there is no check and no warning; a case
recorded before this release replays without it.

Information only: nothing that decides reads it, so every decision is the
same as in 2.0.0-beta.3: a patch. Worked example 4 shows a switched record.

## 2.0.0-beta.3 (2026-11-19)

A likely name, a contaminant's or GenBank's, now rests on the consensus tier
that counts the most agreeing GenBank records, not the strictest tier that
passes. Eight GenBank hits that agree at 99.6 to 100% used to read "2 of 2
NCBI records at >= 100% identity" (only the two at 100% counted at the
strictest tier, and the name's confidence was low); they now read "8 of 8
NCBI records at >= 99.5% identity", with the confidence that goes with eight.
A tie goes to the stricter tier. Naming a specimen is unchanged: it still
takes the strictest tier that passes. Likely names are never a DNA name, so
every decision is the same as in 2.0.0-beta.2: a patch.

## 2.0.0-beta.2 (2026-11-19)

A specimen with only GenBank matches now says what GenBank points to. GenBank
does not name a specimen, so such a specimen had no name at all, even when
every GenBank hit agreed. The result now carries a likely name from GenBank
(`genbankLikelyName`), read the same way as a contaminant's likely name: a
species from the tiered consensus over the GenBank hits, else a genus most
named GenBank hits at 97% or more share. It is set only when the analysis
reached no DNA name and fewer than two validated MycoMap hits qualified, and
never for an eDNA sample, a contaminant, a non-target read or a chimera.

It never becomes the DNA name (`finalSpecies`), so every decision is the same
as in 2.0.0-beta.1: a patch. A case recorded before this release replays the
same; its replay may carry the new field (`RESULT_FIELDS_ADDED_LATER`).

Worked example 4, "Only GenBank matches", shows it.

## 2.0.0-beta.1 (2026-11-19)

A public preview of the engine: the rules of MycoMap auto-validation v1.4,
unchanged, the same code mycomap.org runs. Every decision is the same as
mycomap.org's under v1.4. Version 2.0.0 comes with the command-line tool, a
local app in the browser, and the reference databases to run it against.

What is in it:

- the per-sequence analysis: names from BLAST hits, votes, consensus tiers,
  coverage, the confidence score, contaminant and non-target flags, adjusted
  identity;
- the cross-read passes across one record's reads: non-target by family,
  confidence dominance, the kingdom/phylum override, no BLAST hits, the stray
  read;
- the record decision: wait, leave for a person, reject, or validate as one
  species, with MycoMap Vision and the second source;
- cases: what an analysis, a set of passes or a record decision was asked and
  answered, written down, and run again from that alone;
- worked examples (`pnpm example`) with their inputs, including plain against
  adjusted identity, and a README written for biologists.

The eDNA (environmental sample) branches of the analysis are in the code, but
they read and write mycomap.org's eDNA tables through operations only
mycomap.org hands in; anywhere else an eDNA sequence is refused.

## 2.0.0-alpha.1 (private preview, 18 November 2026)

The same rules, before the repository was public.
