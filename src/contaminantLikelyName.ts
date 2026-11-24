// A likely name for a sequence the deterministic analysis flags as a contaminant.
//
// The analysis stops at the flag (mycomap.org's batchAnalysisService.ts, steps 2, 2b
// and 3c), before any species consensus, so a contaminant had no name at all:
// 9,119 stored results on production on 2026-11-15, none with a species. The
// flag is unchanged. This only says what the contaminant most likely is, for
// people who work on moulds and yeasts as well as macrofungi (2026-11-15).
//
// The name comes from NCBI, in this order:
//   1. a species: the analysis's own tiered consensus over the NCBI hits, at
//      the passing tier that counts the most agreeing records (2.0.0-beta.3;
//      before, the strictest passing tier);
//   2. a genus: the genus most named NCBI hits at >= 97% identity share
//      (>= 70% of them, at least 2 records);
//   3. the name on the contaminant list that raised the flag.
// Never from MycoBLAST. A flagged MycoMap sequence usually carries its host
// record's name (the commonest on production are Fungi, Polyporales, Trametes
// versicolor and Russula), which is the specimen, not the contaminant.
//
// The name and confidence travel in their own field on the result
// (contaminantLikelyName), never in finalSpecies / finalConfidence. Those name
// the specimen, and everything that reads them (auto-validation, sequence
// names, comments) must keep seeing none for a contaminant.
import { isContaminantName } from "./contaminantGenera";
import { isBinomialName, isEnvCodeName, isUnculturedName } from "./speciesNames";

// "closest_ncbi_hit": a stray read with no NCBI consensus, named only as far as its closest covering match goes (strayRead.ts).
export type ContaminantNameSource = "ncbi_species" | "ncbi_genus" | "contaminant_list" | "closest_ncbi_hit";

export interface ContaminantLikelyName {
  /** "Cladosporium cladosporioides", "Cladosporium sp." or "Saccharomycetales". */
  name: string;
  rank: "species" | "genus" | "above_genus";
  /** 0-100. How sure the NAME is; the contaminant flag itself has no score. */
  confidence: number;
  source: ContaminantNameSource;
  /** Records that carry the name, of the records counted (for the list: of the top NCBI hits checked). */
  count: number;
  total: number;
  /** The identity the counted NCBI records had to reach; null for the list. */
  identityThreshold: number | null;
  /** False when the name is not on the contaminant list: the flag and the name disagree. */
  onContaminantList: boolean;
  /** One line for the analysis steps and the page. */
  summary: string;
}

/** A named, cultured NCBI hit and its identity to the query, in percent. */
export interface ContaminantNameVote {
  name: string;
  identity: number;
}

/** The tiered species consensus over the NCBI hits, when a tier passed. */
export interface ContaminantSpeciesConsensus {
  name: string;
  count: number;
  total: number;
  identityThreshold: number;
}

/** The contaminant-list entry found in the top NCBI hits, when that raised the flag. */
export interface ContaminantListTrigger {
  name: string;
  hits: number;
  checked: number;
}

export const CONTAMINANT_GENUS_IDENTITY = 97;
export const CONTAMINANT_GENUS_AGREEMENT = 0.7;
export const CONTAMINANT_GENUS_MIN_RECORDS = 2;

const ABOVE_GENUS_ENDING = /(oideae|aceae|ineae|ales|mycetes|mycota|mycotina|mycetidae)$/i;

/** The genus a hit name starts with, or null when its first word is not a genus. */
export function genusOfHitName(name: string): string | null {
  const first = name.trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Z][a-z]+$/.test(first) || ABOVE_GENUS_ENDING.test(first)) return null;
  return first;
}

/**
 * How much a count of NCBI records is worth, 0-1: the weight the analysis
 * already gives NCBI in its confidence score (full weight from 29 records).
 */
function recordWeight(total: number): number {
  return Math.min(1, Math.log10(total + 1) / Math.log10(30));
}

const pct = (count: number, total: number) => (total > 0 ? count / total : 0);

/** The genus most of the votes at >= 97% identity share, if enough of them agree. */
export function contaminantGenusConsensus(votes: ContaminantNameVote[]): { genus: string; count: number; total: number } | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const vote of votes) {
    if (!(vote.identity >= CONTAMINANT_GENUS_IDENTITY)) continue;
    const genus = genusOfHitName(vote.name);
    if (!genus) continue;
    total++;
    counts.set(genus, (counts.get(genus) ?? 0) + 1);
  }
  // Most records first; a tie goes to the alphabetically first genus, so the same hits always give the same name.
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!top) return null;
  const [genus, count] = top;
  if (count < CONTAMINANT_GENUS_MIN_RECORDS || pct(count, total) < CONTAMINANT_GENUS_AGREEMENT) return null;
  return { genus, count, total };
}

export function contaminantLikelyName(input: {
  speciesConsensus: ContaminantSpeciesConsensus | null;
  ncbiVotes: ContaminantNameVote[];
  listTrigger: ContaminantListTrigger | null;
}): ContaminantLikelyName | null {
  const { speciesConsensus, ncbiVotes, listTrigger } = input;

  if (speciesConsensus && speciesConsensus.total > 0) {
    const { name, count, total, identityThreshold } = speciesConsensus;
    return {
      name,
      rank: "species",
      confidence: Math.round(60 + 35 * recordWeight(total) * pct(count, total)),
      source: "ncbi_species",
      count,
      total,
      identityThreshold,
      onContaminantList: isContaminantName(name),
      summary: `Likely ${name}: ${count} of ${total} NCBI records at >= ${identityThreshold}% identity`,
    };
  }

  const genus = contaminantGenusConsensus(ncbiVotes);
  if (genus) {
    const name = `${genus.genus} sp.`;
    return {
      name,
      rank: "genus",
      confidence: Math.round(40 + 35 * recordWeight(genus.total) * pct(genus.count, genus.total)),
      source: "ncbi_genus",
      count: genus.count,
      total: genus.total,
      identityThreshold: CONTAMINANT_GENUS_IDENTITY,
      onContaminantList: isContaminantName(name),
      summary: `Likely ${name}: ${genus.count} of ${genus.total} named NCBI records at >= ${CONTAMINANT_GENUS_IDENTITY}% identity are ${genus.genus}; NCBI has no species consensus`,
    };
  }

  if (listTrigger && listTrigger.checked > 0) {
    const isGenus = genusOfHitName(listTrigger.name) !== null;
    const name = isGenus ? `${listTrigger.name} sp.` : listTrigger.name;
    return {
      name,
      rank: isGenus ? "genus" : "above_genus",
      confidence: Math.round(20 + 20 * pct(listTrigger.hits, listTrigger.checked)),
      source: "contaminant_list",
      count: listTrigger.hits,
      total: listTrigger.checked,
      identityThreshold: null,
      onContaminantList: true,
      summary: `Likely ${name}: named in ${listTrigger.hits} of the top ${listTrigger.checked} NCBI hits; NCBI has no consensus`,
    };
  }

  return null;
}

/** What the analysis's tiered species consensus returns; `tier` is null when no tier passed. */
export interface TieredConsensusOutcome {
  tier: string | null;
  topCanonical: string | null;
  topCount: number;
  total: number;
  identityThreshold: number;
}

/**
 * The likely name from an analysis's NCBI hits. The server's analysis and the
 * web page's copy both call this with their own helpers, so the two can't
 * drift. Votes are picked as the NCBI consensus step picks them: names above
 * genus and uncultured records don't vote, and a hit with no identity is left out.
 */
export function likelyContaminantNameFromHits<Hit>(
  ncbiHits: Hit[],
  helpers: {
    /** The curated GenBank name, else the name in the hit's title. */
    nameOf: (hit: Hit) => string | null;
    /** Adjusted identity in percent, else raw; null when the hit has neither. */
    identityOf: (hit: Hit) => number | null;
    /** The analysis's rule for a name that may vote (isConsensusVoteName). */
    isVoteName: (name: string | null) => boolean;
    /** The analysis's tiered consensus (iterativeBinomialConsensus with the regular tiers). */
    speciesConsensus: (entries: { binomial: string; adjIdentity: number }[]) => TieredConsensusOutcome;
  },
  listTrigger: ContaminantListTrigger | null,
): ContaminantLikelyName | null {
  const ncbiVotes: ContaminantNameVote[] = [];
  for (const hit of ncbiHits) {
    const name = helpers.nameOf(hit);
    if (!name || !helpers.isVoteName(name) || isUnculturedName(name)) continue;
    const identity = helpers.identityOf(hit);
    if (identity === null || !Number.isFinite(identity)) continue;
    ncbiVotes.push({ name, identity });
  }
  const consensus = helpers.speciesConsensus(
    ncbiVotes
      .filter((vote) => isBinomialName(vote.name) && !isEnvCodeName(vote.name))
      .map((vote) => ({ binomial: vote.name, adjIdentity: vote.identity })),
  );
  return contaminantLikelyName({
    speciesConsensus: consensus.tier && consensus.topCanonical
      ? { name: consensus.topCanonical, count: consensus.topCount, total: consensus.total, identityThreshold: consensus.identityThreshold }
      : null,
    ncbiVotes,
    listTrigger,
  });
}

/** The line a flagged result's last analysis step gets. */
export function contaminantNameStepDetail(likely: ContaminantLikelyName | null): string {
  return likely ? likely.summary : "No likely name: NCBI has no consensus for this sequence";
}

/** What the name rests on, without the name: "18 of 20 NCBI records at >= 99.5% identity". */
export function contaminantNameBasis(likely: Pick<ContaminantLikelyName, "name" | "summary">): string {
  const prefix = `Likely ${likely.name}: `;
  return likely.summary.startsWith(prefix) ? likely.summary.slice(prefix.length) : likely.summary;
}

/** "Contaminant: likely Cladosporium sp. (62%)", or the flag alone when there is no name. */
export function contaminantLabel(likely: Pick<ContaminantLikelyName, "name" | "confidence"> | null | undefined): string {
  return likely?.name ? `Contaminant: likely ${likely.name} (${likely.confidence}%)` : "Contaminant";
}
