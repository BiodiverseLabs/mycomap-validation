/**
 * A new provisional name for a record that nothing validated names
 * (2026-11-16).
 *
 * When the analysis ends with "barcode gap analysis needed" (no MycoBLAST
 * match, no NCBI consensus), the barcode gap analysis is run on the sequence's
 * MycoBLAST hits and the sequence's own cluster is read:
 *
 *   - if no MycoMap record validated green sits in that cluster, the record
 *     is a candidate for a new name. Other MycoMap records in the cluster that
 *     are not validated are fine: they are candidates for the same name, also
 *     when their read carries the Low quality flag (2026-11-16: "Low Q
 *     flag should not limit putting the suggested new name line on. Applying
 *     would remove the flag"). NCBI sequences never count against it;
 *   - the new name's base is voted on by the 10 closest usable hits of NCBI
 *     and the 10 of MycoBLAST, each weighted by its identity: the genus when
 *     one holds more than half the weight, else the family, else the order
 *     (2026-11-18). Uncultured names, names above order, GenBank's
 *     stand-in names such as "Vouchered mycorrhizae" (no taxon, only a
 *     description), the record's own reads, and references that are trashed
 *     or flagged (contaminant, non-target, wrong specimen) do not vote. A hit
 *     votes only when it covers most of the read, by the analysis's own
 *     query-cover rule: a short match on a conserved stretch names nothing;
 *   - a read must speak for its record. A name is the record's, so nothing is
 *     suggested from a read while another usable read of the same record sits
 *     outside its cluster (sequence 892545: one stray read on a record whose
 *     six other reads are Cantharellus tenuithrix).
 *
 * These are the rules only. Running the barcode gap tool, finding the next
 * free number of a code series and creating the name are the caller's.
 */
import {
  LOW_QUALITY_FLAG_NAMES,
  QUERY_COVERAGE_THRESHOLD,
  authoritativeSequenceFlags,
  extractGenus,
  getSpeciesNameFromHit,
  isExcludedReference,
  isTrashReference,
  isValidTaxonomicName,
  type BlastHit,
  type GenBankRecord,
  type SequenceRecord,
  LOW_IDENTITY_CHECK_THRESHOLD,
  MIN_VALIDATED_HITS,
} from "./analysisRules";
import { hasExcludedSequenceFlag, isWrongSpecimenFlagName } from "./sequenceExclusionFlags";
import { isPlaceholderOrganismName, isRealBinomial, isUnculturedName, speciesNamesMatch } from "./speciesNames";
import { ABOVE_GENUS_PATTERN, ABOVE_GENUS_WORDS } from "./aboveGenusNames";
import { canonicalGenus, type TaxonLookup } from "./autovalidationTaxonomy";

const COMPLEMENT: Record<string, string> = {
  A: "T", T: "A", G: "C", C: "G", a: "t", t: "a", g: "c", c: "g",
  R: "Y", Y: "R", S: "S", W: "W", K: "M", M: "K", B: "V", V: "B", D: "H", H: "D", N: "N",
  r: "y", y: "r", s: "s", w: "w", k: "m", m: "k", b: "v", v: "b", d: "h", h: "d", n: "n",
};

function reverseComplement(sequence: string): string {
  let out = "";
  for (let i = sequence.length - 1; i >= 0; i--) out += COMPLEMENT[sequence[i]] ?? sequence[i];
  return out;
}

function wrap(lines: string[], sequence: string): void {
  for (let i = 0; i < sequence.length; i += 80) lines.push(sequence.substring(i, i + 80));
}

/**
 * The name the query goes by in the barcode gap input, and in the clusters
 * that come back: "Query_" and the BLAST result's own query id, as the BLAST
 * page's Barcode Gap Analysis tab names it, so a run saved by either reads the
 * same there.
 */
export function barcodeGapQueryHeader(queryLabel: string | null | undefined): string {
  return `Query_${String(queryLabel ?? "").trim() || "sequence"}`;
}

/**
 * The barcode gap tool's input for one sequence: the query as its first hit
 * aligned it, then each hit's aligned part, turned to the query's strand.
 * The same input the BLAST page's Barcode Gap Analysis tab builds. Null when
 * there is nothing to compare (no hit carries an alignment).
 */
export function barcodeGapFasta(queryLabel: string | null | undefined, hits: BlastHit[]): { fasta: string; queryHeader: string; sequences: number } | null {
  const first = hits[0]?.hsps[0];
  if (!first?.qseq) return null;
  const queryHeader = barcodeGapQueryHeader(queryLabel);
  const lines: string[] = [`>${queryHeader} | Query sequence`];
  wrap(lines, first.qseq.replace(/-/g, ""));
  let sequences = 1;
  for (const hit of hits) {
    const hsp = hit.hsps[0];
    if (!hsp?.hseq || !hit.accession) continue;
    const minus = hsp.hitFrom > hsp.hitTo;
    const aligned = hsp.hseq.replace(/-/g, "");
    lines.push(`>${hit.accession}${minus ? " [RC]" : ""} | hit #${hit.num}`);
    wrap(lines, minus ? reverseComplement(aligned) : aligned);
    sequences++;
  }
  return sequences < 2 ? null : { fasta: lines.join("\n"), queryHeader, sequences };
}

/** The part of the barcode gap tool's answer the rule reads. */
export interface BarcodeGapClusters {
  clusters?: Array<{ sequence_ids?: unknown; all_sequence_ids?: unknown }> | null;
  query_cluster_index?: number | null;
}

/**
 * The hits that share the query's cluster, by accession; the query itself is
 * left out. Null when the answer does not say which cluster the query is in.
 */
export function queryClusterAccessions(gap: BarcodeGapClusters | null | undefined): string[] | null {
  const clusters = Array.isArray(gap?.clusters) ? gap!.clusters! : null;
  const index = gap?.query_cluster_index;
  if (!clusters || typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= clusters.length) return null;
  const cluster = clusters[index];
  // sequence_ids is cut to the first 20 for display; all_sequence_ids is the cluster.
  const ids = Array.isArray(cluster?.all_sequence_ids) ? cluster.all_sequence_ids
    : Array.isArray(cluster?.sequence_ids) ? cluster.sequence_ids : null;
  if (!ids) return null;
  const members = ids.map((id) => String(id)).filter((id) => id !== "" && !id.startsWith("Query_"));
  return [...new Set(members)];
}

/** The record a MycoMap sequence belongs to, as "platform:id"; null for a sequence with no record. */
export function recordKeyOfSequence(record: SequenceRecord | null | undefined): string | null {
  if (!record) return null;
  const inat = record.inatObservationId;
  if (inat !== null && inat !== undefined && String(inat) !== "") return `inat:${inat}`;
  const mo = record.moObservationId;
  if (mo !== null && mo !== undefined && String(mo) !== "") return `mo:${mo}`;
  const id = record.observationId;
  if (id === null || id === undefined || String(id) === "") return null;
  const platform = typeof record.platform === "string" && record.platform ? record.platform.toLowerCase() : "record";
  return `${platform}:${id}`;
}

/** A reference that is no evidence for a name: trashed, low quality, wrong specimen, or flagged contaminant (non-target). */
export function isUnusableReference(record: SequenceRecord): boolean {
  return isTrashReference(record) || isExcludedReference(record) || hasExcludedSequenceFlag(record.flags);
}

/** Whether the read carries the Low quality flag (the flag Apply removes once the record is named). */
export function hasLowQualityFlag(record: SequenceRecord): boolean {
  return authoritativeSequenceFlags(record).some((flag) => LOW_QUALITY_FLAG_NAMES.has(flag));
}

/**
 * A read no record can be named through: trashed, on the wrong specimen, or
 * flagged contaminant (non-target). A Low quality flag alone is not that: it
 * says the read is poor evidence for a name, not that it is another fungus.
 */
export function isUnnameableRead(record: SequenceRecord): boolean {
  return isTrashReference(record) || hasExcludedSequenceFlag(record.flags) || authoritativeSequenceFlags(record).some(isWrongSpecimenFlagName);
}

function isValidatedGreen(record: SequenceRecord): boolean {
  return record.validated !== false && record.validationStatus === "verified";
}

export interface ClusterRecord {
  /** "inat:123"; null for sequences that belong to no record. */
  record: string | null;
  sequenceIds: string[];
  name: string | null;
}

export interface NewNameVerdict {
  /** True when the cluster holds no MycoMap record validated green. */
  candidate: boolean;
  reason: "no_validated_record_in_cluster" | "validated_record_in_cluster";
  /** The record's own reads in the cluster, the analysed one first. */
  ownSequenceIds: string[];
  /** Validated records in the cluster: what the record should be compared with instead of getting a new name. */
  validated: ClusterRecord[];
  /** Other records in the cluster that are not validated: candidates for the same new name. */
  sharedWith: ClusterRecord[];
  /** Cluster members MycoMap holds no sequence record for. */
  unknownAccessions: string[];
}

/**
 * Whether the record is a candidate for a new name, from its cluster.
 * `ownRecord` is the analysed sequence's record ("inat:123"), or null when it
 * has none: then only the sequence itself is its own.
 */
export function newNameVerdict(input: {
  sequenceId: string;
  ownRecord: string | null;
  clusterAccessions: string[];
  sequenceMap: Record<string, SequenceRecord>;
}): NewNameVerdict {
  const own = new Set<string>([input.sequenceId]);
  const validated = new Map<string, ClusterRecord>();
  const shared = new Map<string, ClusterRecord>();
  const unknownAccessions: string[] = [];
  const add = (into: Map<string, ClusterRecord>, key: string, record: string | null, accession: string, name: string | null) => {
    const entry = into.get(key) ?? { record, sequenceIds: [], name };
    entry.sequenceIds.push(accession);
    if (!entry.name) entry.name = name;
    into.set(key, entry);
  };
  for (const accession of input.clusterAccessions) {
    if (accession === input.sequenceId) continue;
    const meta = input.sequenceMap[accession];
    if (!meta) {
      unknownAccessions.push(accession);
      continue;
    }
    const record = recordKeyOfSequence(meta);
    if (record !== null && record === input.ownRecord) {
      own.add(accession);
      continue;
    }
    // A trashed, wrong-specimen or contaminant reference is no evidence either way: it neither blocks nor shares.
    if (isUnnameableRead(meta)) continue;
    const key = record ?? `sequence:${accession}`;
    const name = meta.scientificName ?? null;
    if (isValidatedGreen(meta)) {
      // A low-quality read is no evidence for a validated name: as before, it does not block.
      if (!hasLowQualityFlag(meta)) add(validated, key, record, accession, name);
      continue;
    }
    // Not validated: its record shares the cluster and may take the name, Low quality flag or not.
    add(shared, key, record, accession, name);
  }
  // A record with one validated read is a validated record, whatever its other reads say.
  for (const key of validated.keys()) {
    const other = shared.get(key);
    if (!other) continue;
    validated.get(key)!.sequenceIds.push(...other.sequenceIds);
    shared.delete(key);
  }
  const blocked = validated.size > 0;
  return {
    candidate: !blocked,
    reason: blocked ? "validated_record_in_cluster" : "no_validated_record_in_cluster",
    ownSequenceIds: [input.sequenceId, ...[...own].filter((id) => id !== input.sequenceId)],
    validated: [...validated.values()],
    sharedWith: [...shared.values()],
    unknownAccessions,
  };
}

/**
 * The record's other usable reads that are not in the analysed read's
 * cluster. Any at all means the read does not speak for its record: it may be
 * a contaminant or a second organism, and the record is not to be renamed
 * from it. A trashed or flagged read is not a usable one and is not counted.
 */
export function recordReadsOutsideCluster(input: {
  sequenceId: string;
  /** The record's reads the cluster holds, as newNameVerdict found them. */
  clusterOwnSequenceIds: string[];
  recordReads: Array<{ id: string; usable: boolean }>;
}): string[] {
  const inCluster = new Set([input.sequenceId, ...input.clusterOwnSequenceIds]);
  return [...new Set(input.recordReads.filter((read) => read.usable && !inCluster.has(read.id)).map((read) => read.id))];
}

// ── The base of the new name: genus, else family, else order ──
//
// 2026-11-18, on sequence 782936 (suggested "Mollisia sp. 'BC06'" from
// the 5 closest hits, 3 of them Mollisia): "look at the top 10 NCBI and top 10
// MycoBLAST (Non-contaminants) and weight them at each rank according to
// identity". So the 10 closest usable hits of each list vote, each with its
// adjusted identity as its weight. The genus wins when it holds more than half
// of the weight; else the family; else the order. A hit whose name or lookup
// says nothing at a rank still counts in that rank's whole: it is weight that
// does not back the leader.

/** How many of each list's closest usable hits vote: 10 from MycoBLAST and 10 from NCBI. */
export const NEW_NAME_VOTE_HITS_PER_SOURCE = 10;
/** The share of the voting weight a taxon must hold at a rank, more than this. */
export const NEW_NAME_RANK_SHARE = 0.5;
/** The ranks a new name may be based on, finest first. */
export const NEW_NAME_RANKS = ["genus", "family", "order"] as const;
export type NameBaseRank = (typeof NEW_NAME_RANKS)[number];

/**
 * The word a hit's name places it under, and that word's rank: "Mollisia sp."
 * -> Mollisia (genus), "Mollisiaceae" -> family, "Helotiales sp. 'CA04'" ->
 * Helotiales (order). Null for a name that cannot vote: uncultured, GenBank's
 * stand-ins, and names above order (Fungi, Ascomycota, Leotiomycetes), which
 * say nothing at the ranks a name is based on.
 */
export function nameBase(name: string | null | undefined): { word: string; rank: NameBaseRank } | null {
  const text = String(name ?? "").trim();
  if (!text || !isValidTaxonomicName(text) || isUnculturedName(text) || isPlaceholderOrganismName(text)) return null;
  const first = text.split(/\s+/)[0];
  if (!/^[A-Z][a-zë]+$/.test(first) || ABOVE_GENUS_WORDS.has(first.toLowerCase())) return null;
  if (/aceae$/.test(first)) return { word: first, rank: "family" };
  if (/ales$/.test(first)) return { word: first, rank: "order" };
  if (ABOVE_GENUS_PATTERN.test(first)) return null;
  return { word: canonicalGenus(first) ?? first, rank: "genus" };
}

export interface NameVoteHit {
  source: "local" | "ncbi";
  accession: string;
  name: string;
  /** Adjusted identity in percent: the hit's weight. */
  identity: number;
  base: string;
  baseRank: NameBaseRank;
}

export interface PlacedVoteHit extends NameVoteHit {
  genus: string | null;
  family: string | null;
  order: string | null;
}

export interface RankTally {
  rank: NameBaseRank;
  /** The taxa at this rank, most weight first. `share` is of the whole pool's weight, 0-1. */
  taxa: Array<{ taxon: string; hits: number; weight: number; share: number }>;
}

export interface TaxonConsensus {
  /** The word the new name is based on (a genus, family or order); null when no rank has a taxon with more than half the weight. */
  genus: string | null;
  rank: NameBaseRank | null;
  reason: "consensus" | "no_majority" | "too_few_named_hits";
  /** The taxa at the rank chosen (or at order when none was), most weight first. */
  votes: Array<{ genus: string; count: number; share: number }>;
  /** The hits that voted, closest first. */
  considered: PlacedVoteHit[];
  /** Every rank's tally, genus first. */
  tallies: RankTally[];
}

/**
 * The hits that vote on the new name's base: from each list, the
 * `NEW_NAME_VOTE_HITS_PER_SOURCE` closest by adjusted identity (equal identity
 * keeps BLAST's order) that cover at least `QUERY_COVERAGE_THRESHOLD` percent
 * of the read and carry a name `nameBase` accepts. MycoBLAST hits are not the
 * record's own reads, not trashed or flagged (contaminant, wrong specimen, low
 * quality), and one per record: a record's second read is no second opinion.
 */
export function newNameVotePool(input: {
  localHits: BlastHit[];
  ncbiHits: BlastHit[];
  localAdjusted: Record<number, number>;
  ncbiAdjusted: Record<number, number>;
  sequenceMap: Record<string, SequenceRecord>;
  genbankMap: Record<string, GenBankRecord>;
  ownSequenceIds: string[];
  ownRecord: string | null;
}): NameVoteHit[] {
  const own = new Set(input.ownSequenceIds);
  const coversTheRead = (hit: BlastHit) => typeof hit.queryCoverage === "number" && hit.queryCoverage >= QUERY_COVERAGE_THRESHOLD;
  const closest = (hits: BlastHit[], adjusted: Record<number, number>) => hits
    .map((hit, order) => ({ hit, order, identity: adjusted[hit.num] }))
    .filter((row): row is { hit: BlastHit; order: number; identity: number } => typeof row.identity === "number" && Number.isFinite(row.identity) && row.identity > 0)
    .sort((a, b) => b.identity - a.identity || a.order - b.order);

  const local: NameVoteHit[] = [];
  const recordsVoted = new Set<string>();
  for (const { hit, identity } of closest(input.localHits, input.localAdjusted)) {
    if (local.length >= NEW_NAME_VOTE_HITS_PER_SOURCE) break;
    if (own.has(hit.accession) || !coversTheRead(hit)) continue;
    const meta = input.sequenceMap[hit.accession];
    const record = meta ? recordKeyOfSequence(meta) : null;
    if (meta) {
      if (input.ownRecord !== null && record === input.ownRecord) continue;
      if (isUnusableReference(meta)) continue;
    }
    const name = getSpeciesNameFromHit(hit, input.sequenceMap);
    const base = nameBase(name);
    if (!name || !base) continue;
    if (record) {
      if (recordsVoted.has(record)) continue;
      recordsVoted.add(record);
    }
    local.push({ source: "local", accession: hit.accession, name, identity, base: base.word, baseRank: base.rank });
  }

  const ncbi: NameVoteHit[] = [];
  for (const { hit, identity } of closest(input.ncbiHits, input.ncbiAdjusted)) {
    if (ncbi.length >= NEW_NAME_VOTE_HITS_PER_SOURCE) break;
    if (!coversTheRead(hit)) continue;
    const name = getSpeciesNameFromHit(hit, {}, input.genbankMap);
    const base = nameBase(name);
    if (!name || !base) continue;
    ncbi.push({ source: "ncbi", accession: hit.accession, name, identity, base: base.word, baseRank: base.rank });
  }

  // Closest first; equal identity keeps MycoBLAST before NCBI.
  return [...local, ...ncbi].sort((a, b) => b.identity - a.identity);
}

/** The genera and families whose family and order the vote needs, for the caller to look up. */
export function taxonWordsToPlace(pool: NameVoteHit[]): string[] {
  return [...new Set(pool.filter((hit) => hit.baseRank !== "order").map((hit) => hit.base))];
}

/** Where each voting hit sits: its own name's rank, the rest from the lookup (keyed by lower-case genus or family). */
export function placeVoteHits(pool: NameVoteHit[], lookup: TaxonLookup): PlacedVoteHit[] {
  return pool.map((hit) => {
    const row = lookup.get(hit.base.toLowerCase()) ?? null;
    if (hit.baseRank === "order") return { ...hit, genus: null, family: null, order: hit.base };
    if (hit.baseRank === "family") return { ...hit, genus: null, family: hit.base, order: row?.order ?? null };
    return { ...hit, genus: hit.base, family: row?.family ?? null, order: row?.order ?? null };
  });
}

/**
 * The finest rank at which one taxon holds more than `NEW_NAME_RANK_SHARE` of
 * the voting weight, from at least two hits: genus, then family, then order.
 */
export function taxonConsensus(placed: PlacedVoteHit[]): TaxonConsensus {
  const total = placed.reduce((sum, hit) => sum + hit.identity, 0);
  const weightOf = (rank: NameBaseRank, taxon: string) => placed.filter((hit) => hit[rank] === taxon).reduce((sum, hit) => sum + hit.identity, 0);
  const tallies: RankTally[] = NEW_NAME_RANKS.map((rank) => {
    const hitsOf = new Map<string, number>();
    for (const hit of placed) {
      const taxon = hit[rank];
      if (taxon) hitsOf.set(taxon, (hitsOf.get(taxon) ?? 0) + 1);
    }
    const taxa = [...hitsOf.entries()]
      .map(([taxon, hits]) => {
        const weight = weightOf(rank, taxon);
        return { taxon, hits, weight: Math.round(weight * 100) / 100, share: total > 0 ? Math.round((weight / total) * 1000) / 1000 : 0 };
      })
      .sort((a, b) => b.weight - a.weight || a.taxon.localeCompare(b.taxon));
    return { rank, taxa };
  });
  const votesOf = (tally: RankTally) => tally.taxa.map((t) => ({ genus: t.taxon, count: t.hits, share: t.share }));
  const orderTally = tallies[tallies.length - 1];
  if (placed.length < 2) return { genus: null, rank: null, reason: "too_few_named_hits", votes: votesOf(orderTally), considered: placed, tallies };
  for (const tally of tallies) {
    const [top] = tally.taxa;
    // Compared unrounded: the share kept is rounded to a tenth of a percent.
    if (top && top.hits >= 2 && weightOf(tally.rank, top.taxon) > total * NEW_NAME_RANK_SHARE) {
      return { genus: top.taxon, rank: tally.rank, reason: "consensus", votes: votesOf(tally), considered: placed, tallies };
    }
  }
  return { genus: null, rank: null, reason: "no_majority", votes: votesOf(orderTally), considered: placed, tallies };
}

/** The pool, placed and tallied, in one call. */
export function closestTaxonConsensus(input: Parameters<typeof newNameVotePool>[0] & { lookup: TaxonLookup }): TaxonConsensus {
  return taxonConsensus(placeVoteHits(newNameVotePool(input), input.lookup));
}

// ── an existing name before a new one (2026-11-19, sequence 884957) ──
//
// A record nothing validated names gets a new provisional name, its base voted
// at genus, family or order. But GenBank may already name the species: 884957
// (Hydnellum) had 7 of 8 GenBank records Hydnellum mirabile at >= 99.5%, and 2
// of its 3 unvalidated MycoMap neighbours carried the same name, yet it was
// offered "Hydnellum sp. 'WA01'". Before a new name is made, this looks for an
// existing species to offer instead; a person still applies it.

/** The closest other species, when within this many identity points of the suggested one's closest hit. */
export const EXISTING_NAME_RIVAL_WINDOW = 0.1;

export interface ExistingNameSuggestion {
  /** The species to offer, as GenBank's records name it. */
  name: string;
  /** Its share of the identity weight of the closest usable hits that name a species (0-1). */
  share: number;
  /** GenBank's records that name it, of those counted, at the identity they had to reach. */
  genbank: { count: number; total: number; identityThreshold: number | null };
  /** The cluster's unvalidated MycoMap records that carry a species name, and how many of them carry this one. */
  shared: { agree: number; total: number };
  /** The closest other species among the hits, when it is within EXISTING_NAME_RIVAL_WINDOW of this one. */
  rival: { name: string; identity: number; nameIdentity: number } | null;
}

export type ExistingNameRefusal =
  | "no_genbank_species"
  | "closest_hits_disagree"
  | "mycomap_names_another"
  | "name_on_distant_sequence"
  | "family_differs";

/**
 * The existing species to offer a record a new name was about to be made for,
 * or why there is none. All of these must hold:
 *   1. GenBank names a species: its likely name (likelyContaminantNameFromNcbi)
 *      is a species, from at least two records;
 *   2. that species holds more than half the identity weight of the closest
 *      usable hits that name a species (the new name's own vote pool; a hit
 *      naming only a genus or higher is neither for it nor against it);
 *   3. the cluster's unvalidated MycoMap records do not mostly carry another species;
 *   4. no hit carrying the name sits below 98.5% (a name on distant sequences may
 *      cover more than one species);
 *   5. its family is not another from the record's, when both are known.
 */
export function existingSpeciesName(input: {
  pool: NameVoteHit[];
  genbank: { name: string; rank: string; count: number; total: number; identityThreshold: number | null } | null;
  sharedNames: Array<string | null>;
  recordFamily?: string | null;
  nameFamily?: string | null;
}): { suggestion: ExistingNameSuggestion; refusal: null } | { suggestion: null; refusal: ExistingNameRefusal } {
  const refuse = (refusal: ExistingNameRefusal) => ({ suggestion: null, refusal }) as const;
  const g = input.genbank;
  if (!g || g.rank !== "species" || g.count < MIN_VALIDATED_HITS || !isRealBinomial(g.name)) return refuse("no_genbank_species");
  const isName = (name: string | null | undefined) => !!name && speciesNamesMatch(name, g.name);

  const total = input.pool.filter((hit) => isRealBinomial(hit.name)).reduce((sum, hit) => sum + hit.identity, 0);
  const named = input.pool.filter((hit) => isName(hit.name));
  const share = total > 0 ? named.reduce((sum, hit) => sum + hit.identity, 0) / total : 0;
  if (share <= 0.5) return refuse("closest_hits_disagree");

  const species = input.sharedNames.filter((name): name is string => isRealBinomial(name));
  const agree = species.filter((name) => isName(name)).length;
  if (species.length - agree > agree) return refuse("mycomap_names_another");

  if (named.some((hit) => hit.identity < LOW_IDENTITY_CHECK_THRESHOLD)) return refuse("name_on_distant_sequence");

  const recordFamily = input.recordFamily?.trim().toLowerCase();
  const nameFamily = input.nameFamily?.trim().toLowerCase();
  if (recordFamily && nameFamily && recordFamily !== nameFamily) return refuse("family_differs");

  const nameIdentity = Math.max(...named.map((hit) => hit.identity));
  const others = input.pool.filter((hit) => isRealBinomial(hit.name) && !isName(hit.name)).sort((a, b) => b.identity - a.identity);
  const closestOther = others[0];
  const rival = closestOther && nameIdentity - closestOther.identity <= EXISTING_NAME_RIVAL_WINDOW + 1e-9
    ? { name: closestOther.name, identity: closestOther.identity, nameIdentity }
    : null;
  return {
    suggestion: {
      name: g.name,
      share: Math.round(share * 1000) / 1000,
      genbank: { count: g.count, total: g.total, identityThreshold: g.identityThreshold },
      shared: { agree, total: species.length },
      rival,
    },
    refusal: null,
  };
}
