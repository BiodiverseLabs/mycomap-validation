// The Node.js that comes inside each download: one version, pinned by its
// checksum for each kind of computer, taken from nodejs.org as it is. Node's
// own builds are signed (and, for macOS, notarized by the Node.js project),
// so the download carries no program of ours that the system has to trust:
// the tool itself is a script that this Node runs.
export const PINNED_NODE = "24.22.3";
const NODE_FOLDER = `https://nodejs.org/dist/v${PINNED_NODE}/`;

/** The downloads, by the names people know their computers by. */
export const DOWNLOAD_PLATFORMS = ["windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"] as const;
export type DownloadPlatform = (typeof DOWNLOAD_PLATFORMS)[number];

export interface NodeBuild {
  platform: DownloadPlatform;
  /** nodejs.org's file: the bare node.exe for Windows, a .tar.gz for the others. */
  fileName: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Where node is inside a .tar.gz; null when the file is node.exe itself. */
  entry: string | null;
}

/** From nodejs.org's SHASUMS256.txt for v24.22.3 (sizes from the files themselves). */
const BUILDS: Record<DownloadPlatform, { file: string; bytes: number; sha256: string }> = {
  "windows-x64": { file: "win-x64/node.exe", bytes: 93944648, sha256: "86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6" },
  "macos-arm64": { file: `node-v${PINNED_NODE}-darwin-arm64.tar.gz`, bytes: 53084299, sha256: "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd" },
  "macos-x64": { file: `node-v${PINNED_NODE}-darwin-x64.tar.gz`, bytes: 54395976, sha256: "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7" },
  "linux-x64": { file: `node-v${PINNED_NODE}-linux-x64.tar.gz`, bytes: 58330843, sha256: "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2" },
  "linux-arm64": { file: `node-v${PINNED_NODE}-linux-arm64.tar.gz`, bytes: 58051304, sha256: "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8" },
};

/** Node.js's licence (with the licences of what it includes), from the release's tag. */
export const NODE_LICENSE = {
  url: `https://raw.githubusercontent.com/nodejs/node/v${PINNED_NODE}/LICENSE`,
  bytes: 157609,
  sha256: "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace",
};

export function nodeBuild(platform: DownloadPlatform): NodeBuild {
  const b = BUILDS[platform];
  return {
    platform,
    fileName: b.file.split("/").pop()!,
    url: `${NODE_FOLDER}${b.file}`,
    bytes: b.bytes,
    sha256: b.sha256,
    entry: b.file.endsWith(".tar.gz") ? `${b.file.replace(/\.tar\.gz$/, "")}/bin/node` : null,
  };
}

/** This computer's download, or null for one there is none for (Windows on ARM runs the x64 one). */
export function downloadPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): DownloadPlatform | null {
  if (platform === "win32" && (arch === "x64" || arch === "arm64")) return "windows-x64";
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  return null;
}

export const isWindows = (platform: DownloadPlatform) => platform.startsWith("windows-");
