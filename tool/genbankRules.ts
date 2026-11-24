// GenBank's text rules, as mycomap.org's GenBank export applies them
// (mycomap.org's genbankSubmission.ts there, where a test
// keeps these the same):
//
//   - every text column is plain ASCII (ó → o, ß → ss);
//   - geo_loc_name starts with a country on NCBI's list and a colon
//     ("USA: Michigan, Marquette County"); a US territory is its own country
//     ("Puerto Rico: Rio Grande");
//   - collection dates stay the calendar day written, and go out as
//     18-Jul-2026, Jul-2026 or 2026;
//   - lat_lon is "38.9848 N 77.0943 W";
//   - ambiguous bases in the first or last 10 are trimmed off (NCBI does not
//     take an ambiguity code as the first base);
//   - a provisional name `Genus "sp-XX01"` goes as `Genus sp. 'XX01'`;
//   - "Identified by" and the read count (RiC) go in the note, which NCBI
//     asks for since it stopped taking an Identified_by column.
import { COUNTRY_ALIASES, INSDC_GEO_LOC_NAMES, ISO2_TO_INSDC } from "./genbankCountries";

// Letters NFD does not split into a base letter and a mark.
const ASCII_LETTERS: Record<string, string> = {
  "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O", "œ": "oe", "Œ": "OE", "ł": "l", "Ł": "L",
  "đ": "d", "Đ": "D", "ð": "d", "Ð": "D", "þ": "th", "Þ": "Th", "ı": "i", "ĸ": "k", "ŋ": "ng", "Ŋ": "Ng",
  "‘": "'", "’": "'", "‚": "'", "′": "'", "“": '"', "”": '"', "„": '"', "″": '"', "«": '"', "»": '"',
  "–": "-", "—": "-", "‐": "-", "‑": "-", "−": "-", "…": "...", "×": "x", "·": ".", "°": " deg ",
  " ": " ", " ": " ", " ": " ",
};

/**
 * Plain ASCII, as NCBI asks: accents dropped (São → Sao), a few letters spelled
 * out (ß → ss), anything else removed. Tabs and line breaks become spaces,
 * since they would break the table.
 */
export function toAscii(value: string | null | undefined): { text: string; changed: boolean } {
  const input = value ?? "";
  let out = "";
  for (const ch of input.normalize("NFD")) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x300 && code <= 0x36f) continue; // combining accent
    if (ASCII_LETTERS[ch] !== undefined) { out += ASCII_LETTERS[ch]; continue; }
    if (ch === "\t" || ch === "\n" || ch === "\r") { out += " "; continue; }
    if (code >= 0x20 && code < 0x7f) out += ch;
  }
  const text = out.replace(/ {2,}/g, " ").trim();
  return { text, changed: text !== input.trim() };
}

/** The organism as NCBI wants a provisional name: `Genus "sp-XX01"` becomes `Genus sp. 'XX01'`. */
export function formatOrganism(species: string | null | undefined): string {
  const name = (species ?? "").trim();
  if (!(name.indexOf('"') > 0)) return name;
  const match = /^(.+?)"(.+?)"$/s.exec(name);
  if (!match) return name.replace(/"/g, "'");
  if (match[1].indexOf("var.") > 0) return name.replace(/"/g, "'");
  const inside = /^sp-(\w+?)(\d+?)$/i.exec(match[2]);
  if (inside) return `${match[1]}sp. '${inside[1]}${inside[2]}'`;
  const rest = match[2].startsWith("sp-") ? match[2].slice(3) : match[2];
  return `${match[1]}sp. '${rest}'`;
}

// ── geo_loc_name ──

const INSDC_BY_LOWER = new Map(INSDC_GEO_LOC_NAMES.map((name) => [name.toLowerCase(), name]));

/** NCBI's name for a country as written (a two-letter code, an older name, NCBI's own), or null. */
export function insdcCountry(raw: string | null | undefined): string | null {
  const text = toAscii(raw).text.trim();
  if (!text) return null;
  if (/^[A-Za-z]{2}$/.test(text) && text === text.toUpperCase()) return ISO2_TO_INSDC[text] ?? null;
  const lower = text.toLowerCase();
  return INSDC_BY_LOWER.get(lower) ?? COUNTRY_ALIASES[lower] ?? null;
}

/** US territories that are countries on NCBI's list: "Puerto Rico: Rio Grande", never "USA: Puerto Rico, Rio Grande". */
const US_TERRITORIES = new Set(["Puerto Rico", "Guam", "Virgin Islands", "American Samoa", "Northern Mariana Islands"]);

function territoryOf(place: string | null | undefined): string | null {
  const country = insdcCountry(place);
  return country && US_TERRITORIES.has(country) ? country : null;
}

function withCountry(country: string, tail: string): string {
  const parts = tail.split(",").map((p) => p.trim()).filter(Boolean);
  const territory = country === "USA" ? territoryOf(parts[0]) : null;
  if (territory) return parts.length > 1 ? `${territory}: ${parts.slice(1).join(", ")}` : territory;
  return tail ? `${country}: ${tail}` : country;
}

/** geo_loc_name from a location's parts: "USA: Michigan, Marquette County, Marquette" (region, county, place). */
export function geoLocNameFromParts(parts: { country: string | null; region: string | null; county: string | null; city: string | null }): string {
  const named = insdcCountry(parts.country);
  const territory = !named || named === "USA" ? territoryOf(parts.region) : null;
  const country = territory ?? named ?? (parts.country ?? "").trim();
  const rest = [territory ? null : parts.region, parts.county, parts.city].map((p) => (p ?? "").trim()).filter(Boolean);
  if (!country) return rest.join(", ");
  return rest.length ? `${country}: ${rest.join(", ")}` : country;
}

/**
 * A location as NCBI takes it: the country before the colon in NCBI's
 * spelling, ASCII throughout. `problem` says why NCBI would refuse it (no
 * country, or one not on the list); the text is then left as it is.
 */
export function normalizeGeoLocName(raw: string | null | undefined, countryHint: string | null = null): { value: string; problem: string | null } {
  const text = toAscii(raw).text.replace(/\s*:\s*/, ": ").trim();
  if (!text) return { value: "", problem: "no location: NCBI requires geo_loc_name" };
  const colon = text.indexOf(":");
  const head = colon >= 0 ? text.slice(0, colon) : text;
  const tail = colon >= 0 ? text.slice(colon + 1).trim() : "";
  const country = insdcCountry(head);
  if (country) return { value: withCountry(country, tail), problem: null };
  if (colon === 0) {
    const [lead, ...rest] = tail.split(",");
    const leading = insdcCountry(lead);
    if (leading) return { value: withCountry(leading, rest.join(",").trim()), problem: null };
  }
  if (colon < 0) {
    const hinted = insdcCountry(countryHint);
    if (hinted) return { value: withCountry(hinted, text), problem: null };
    return { value: text, problem: `the location "${text}" does not start with a country and a colon, e.g. "USA: Michigan, Marquette County"` };
  }
  return { value: text, problem: `"${head}" is not on NCBI's country list; use NCBI's name (e.g. USA, Czechia, Russia, Viet Nam)` };
}

/** collected_by without iNaturalist's label: "iNaturalist User: someone" becomes "someone". */
const COLLECTOR_LABEL = /^\s*(?:inaturalist|inat)\s+user\b\s*[:,-]?\s*/i;
export function cleanCollector(value: string | null | undefined): string {
  let text = toAscii(value).text;
  while (COLLECTOR_LABEL.test(text)) text = text.replace(COLLECTOR_LABEL, "");
  return text.trim();
}

// ── Dates and coordinates ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date as a calendar day, month or year ("2026-07-18", "1956-01", "1956"),
 * from its text. An unknown day or month written as 00 ("1956-01-00") is left
 * out. A time after the date is ignored, never converted: the day is the day
 * written.
 */
export function calendarDate(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:[T ].*)?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] === undefined ? 0 : Number(match[2]);
  const day = match[3] === undefined ? 0 : Number(match[3]);
  if (year < 1000 || month > 12 || day > 31) return null;
  if (month === 0) return String(year);
  const mm = String(month).padStart(2, "0");
  if (day === 0) return `${year}-${mm}`;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return `${year}-${mm}-${String(day).padStart(2, "0")}`;
}

/** NCBI's collection_date: 18-Jul-2026, Jul-2026 or 2026. */
export function formatCollectionDate(value: string | null | undefined): string {
  const day = calendarDate(value);
  if (!day) return "";
  const [year, month, dd] = day.split("-");
  if (!month) return year;
  const mon = MONTHS[Number(month) - 1];
  return dd ? `${dd}-${mon}-${year}` : `${mon}-${year}`;
}

/** NCBI's lat_lon, "38.9848 N 77.0943 W" (decimal degrees, at most 6 places as given), or "" when unusable. */
export function formatLatLon(lat: string | number | null | undefined, lon: string | number | null | undefined): string {
  const la = Number(lat);
  const lo = Number(lon);
  if (lat === null || lat === undefined || lon === null || lon === undefined || `${lat}`.trim() === "" || `${lon}`.trim() === "") return "";
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) return "";
  const places = (v: string | number) => Math.min(6, (`${v}`.split(".")[1] ?? "").length);
  const fmt = (v: number, p: number) => Math.abs(v).toFixed(p);
  return `${fmt(la, places(lat))} ${la < 0 ? "S" : "N"} ${fmt(lo, places(lon))} ${lo < 0 ? "W" : "E"}`;
}

// ── Sequences ──

export const END_WINDOW = 10;
/** A trim that would remove more than this from one end stops and is flagged instead. */
export const MAX_END_TRIM = 50;

export interface TrimResult {
  sequence: string;
  trimmedStart: string;
  trimmedEnd: string;
  /** More ambiguity near an end than a trim should take (left for a person). */
  problem: string | null;
}

const isPlainBase = (ch: string) => ch === "A" || ch === "C" || ch === "G" || ch === "T";

/**
 * Trims ambiguous bases (IUPAC codes other than A, C, G, T, N included) off
 * both ends: while any of the first 10 bases is ambiguous, everything up to and
 * including the last such base goes; the same from the other end. Stops at 50
 * bases per end and leaves that end to a person.
 */
export function trimAmbiguousEnds(raw: string | null | undefined, window = END_WINDOW): TrimResult {
  let seq = (raw ?? "").replace(/\s+/g, "").toUpperCase();
  let trimmedStart = "";
  let trimmedEnd = "";
  const problems: string[] = [];
  for (;;) {
    const head = seq.slice(0, window);
    let last = -1;
    for (let i = 0; i < head.length; i++) if (!isPlainBase(head[i])) last = i;
    if (last < 0) break;
    if (trimmedStart.length + last + 1 > MAX_END_TRIM) { problems.push("start"); break; }
    trimmedStart += seq.slice(0, last + 1);
    seq = seq.slice(last + 1);
  }
  for (;;) {
    const tail = seq.slice(Math.max(0, seq.length - window));
    let first = -1;
    for (let i = tail.length - 1; i >= 0; i--) if (!isPlainBase(tail[i])) first = i;
    if (first < 0) break;
    const cut = tail.length - first;
    if (trimmedEnd.length + cut > MAX_END_TRIM) { problems.push("end"); break; }
    trimmedEnd = seq.slice(seq.length - cut) + trimmedEnd;
    seq = seq.slice(0, seq.length - cut);
  }
  return {
    sequence: seq,
    trimmedStart,
    trimmedEnd,
    problem: problems.length ? `ambiguous bases keep coming near the ${problems.join(" and ")} of the sequence; trim it by hand` : null,
  };
}

// ── The note ──

const NOTE_SEPARATOR = "; ";
/** Parts of a note the export adds itself, so a sheet's note that already has them does not get them twice. */
const AUTO_SEGMENT = [(s: string) => /^RiC \d+$/i.test(s), (s: string) => /^Identified by\b/i.test(s)];

/** The note NCBI gets: the sheet's note (each part once), "Identified by …", then the read's RiC. */
export function composeNote(input: { note: string | null | undefined; identifiedBy: string | null | undefined; ric: number | null }): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of (input.note ?? "").split(";")) {
    const segment = raw.trim();
    if (!segment || AUTO_SEGMENT.some((t) => t(segment)) || seen.has(segment.toLowerCase())) continue;
    seen.add(segment.toLowerCase());
    parts.push(segment);
  }
  const identified = (input.identifiedBy ?? "").trim();
  if (identified) parts.push(`Identified by ${identified}`);
  if (input.ric !== null && input.ric !== undefined) parts.push(`RiC ${input.ric}`);
  return parts.join(NOTE_SEPARATOR);
}
