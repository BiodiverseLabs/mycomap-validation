/**
 * Moulds, yeasts and other organisms that grow on or in a collection, or in
 * the laboratory, and turn up in its sequences: the deterministic analysis's
 * contaminant list. A sequence of one of these on a specimen is a biological
 * contaminant; any other organism's sequence on the wrong specimen is a mix-up.
 */
export const CONTAMINANT_GENERA = ["Candida", "Kodamaea", "Aspergillus", "Verticillium", "Saccharomycetales", "Saccharomycetaceae", "Wallemia", "Cladosporium", "Aureobasidium", "Cercomonas", "Mortierellales", "Mortierella"];

/** Whether a name's first word is on the contaminant list. */
export const isContaminantName = (name: string | null | undefined): boolean => {
  const first = String(name ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return Boolean(first) && CONTAMINANT_GENERA.some(genus => genus.toLowerCase() === first);
};
