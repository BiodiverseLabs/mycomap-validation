// The BLAST+ that `init` installs: one version, pinned by its checksum for
// each kind of computer, so a result can name the exact BLAST that made it.
// Only blastn and blastdbcmd are kept (and the libraries they need on
// Windows), in <data>/blast/<version>/. BLAST+ is NCBI's, a work of the US
// government and in the public domain.
import fs from "node:fs";
import path from "node:path";

export const PINNED_BLAST = "2.17.0";
const NCBI_FOLDER = `https://ftp.ncbi.nlm.nih.gov/blast/executables/blast+/${PINNED_BLAST}/`;

export interface BlastBuild {
  platform: string;
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** NCBI's BLAST+ 2.17.0 archives: sizes and SHA-256 worked out from the files (each matched NCBI's own .md5). */
const BUILDS: Record<string, { bytes: number; sha256: string }> = {
  "x64-win64": { bytes: 143400333, sha256: "ccde8788641e8f4137536aaadedfeac2f3599dbbc6166e701b5d89d19fa79038" },
  "x64-linux": { bytes: 296006458, sha256: "3888112d8207831aa47371d93583c601f058f88b5db22dc782438b039a3a411b" },
  "aarch64-linux": { bytes: 243442823, sha256: "cb9ac252a1ac8767d90b0bf0a38486f3cb94f71ef9b6b8d194ded19b30250daf" },
  "x64-macosx": { bytes: 218771068, sha256: "0f4cc34dec108ac92a55df676365ce6751171f8377d195c13ee2f59f5e01770c" },
  "aarch64-macosx": { bytes: 205531226, sha256: "8d6739fa133107bce91dbb6b143ec993c9983416244fe502f9c36d585850dc00" },
};

/** NCBI's name for a computer: Windows on ARM runs the x64 build. */
export function blastPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | null {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "x64-win64";
  if (platform === "linux" && arch === "x64") return "x64-linux";
  if (platform === "linux" && arch === "arm64") return "aarch64-linux";
  if (platform === "darwin" && arch === "x64") return "x64-macosx";
  if (platform === "darwin" && arch === "arm64") return "aarch64-macosx";
  return null;
}

/**
 * Where BLAST+ is downloaded from: NCBI's folder, or a copy of it named in
 * MYCOMAP_VALIDATION_BLAST_MIRROR (an institution's mirror, or the release's
 * first-run check). The checksums stay NCBI's, so a mirror cannot change the program.
 */
export function blastSource(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.MYCOMAP_VALIDATION_BLAST_MIRROR?.trim();
  if (!mirror) return NCBI_FOLDER;
  return mirror.endsWith("/") ? mirror : `${mirror}/`;
}

export function blastBuild(platform: string, from: string = blastSource()): BlastBuild | null {
  const known = BUILDS[platform];
  if (!known) return null;
  const fileName = `ncbi-blast-${PINNED_BLAST}+-${platform}.tar.gz`;
  return { platform, fileName, url: `${from}${fileName}`, ...known };
}

export const BLAST_PLATFORMS = Object.keys(BUILDS);

/**
 * Which files of NCBI's archive to keep, and where: blastn and blastdbcmd, and
 * on Windows their manifests and the libraries beside them. "ncbi-blast-2.17.0+/bin/blastn.exe" →
 * "blastn.exe"; everything else is skipped.
 */
export function blastEntry(name: string): string | null {
  const m = /^[^/]+\/bin\/([^/]+)$/.exec(name);
  if (!m) return null;
  const file = m[1];
  // On Windows each program has a .manifest beside it, and the libraries it loads.
  if (/^(blastn|blastdbcmd)(\.exe(\.manifest)?)?$/.test(file) || /\.dll$/i.test(file)) return file;
  return null;
}

/** The folder of the BLAST+ `init` installed in the data folder, or null. */
export function installedBlastFolder(dataFolder: string): string | null {
  const root = path.join(dataFolder, "blast");
  let versions: string[];
  try {
    versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  } catch {
    return null;
  }
  const sorted = versions.sort((a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  for (const v of sorted.reverse()) {
    const folder = path.join(root, v);
    if (["blastn", "blastn.exe"].some((f) => fs.existsSync(path.join(folder, f)))) return folder;
  }
  return null;
}
