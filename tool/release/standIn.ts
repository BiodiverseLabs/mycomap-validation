// A stand-in for mycomap.org's downloads, on this computer only, for the
// release's first-run check (firstRun.ts): it serves a list of downloads in
// the shape https://mycomap.org/api/downloads has, and the files it names
// from disk, answering Range requests as a file server does. Point the tool
// at it with MYCOMAP_VALIDATION_DOWNLOADS (the list) and
// MYCOMAP_VALIDATION_BLAST_MIRROR (BLAST+), and `init` never leaves the computer.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

export interface StandInFiles {
  /** Release date of MycoMap's database and names table. */
  mycomapVersion: string;
  mycomapDb: string;
  names: string;
  /** GenBank's fungal ITS database, if it is to be offered. */
  ncbi?: { version: string; file: string } | null;
  /** NCBI's BLAST+ archives, served under /blast/ by their own names. */
  blast?: string[];
}

export interface StandIn {
  base: string;
  /** For MYCOMAP_VALIDATION_DOWNLOADS and MYCOMAP_VALIDATION_BLAST_MIRROR. */
  env: { MYCOMAP_VALIDATION_DOWNLOADS: string; MYCOMAP_VALIDATION_BLAST_MIRROR: string };
  /** Each request's path. */
  requests: string[];
  close(): Promise<void>;
}

function described(file: string, url: string) {
  const bytes = fs.statSync(file).size;
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  return { fileName: path.basename(file), url, bytes, sha256 };
}

/** The list of downloads, as mycomap.org's /api/downloads gives it (the parts the tool reads). */
export function downloadsList(base: string, files: StandInFiles) {
  const url = (f: string) => `${base}/files/${encodeURIComponent(path.basename(f))}`;
  return {
    latest: {
      version: files.mycomapVersion,
      files: [
        { id: "mycomap-blastdb", ...described(files.mycomapDb, url(files.mycomapDb)) },
        { id: "mycomap-sequences", ...described(files.names, url(files.names)) },
      ],
    },
    ncbiIts: files.ncbi ? { version: files.ncbi.version, ...described(files.ncbi.file, url(files.ncbi.file)) } : null,
  };
}

export async function startStandIn(files: StandInFiles): Promise<StandIn> {
  const served = new Map<string, string>();
  for (const f of [files.mycomapDb, files.names, files.ncbi?.file].filter((f): f is string => !!f)) served.set(`/files/${path.basename(f)}`, f);
  for (const f of files.blast ?? []) served.set(`/blast/${path.basename(f)}`, f);
  const requests: string[] = [];
  let list = "";
  const server = http.createServer((req, res) => {
    // Files by their own names ("ncbi-blast-2.17.0+-…" may come with its "+" written as %2B).
    const at = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    requests.push(at);
    if (at === "/api/downloads") { res.writeHead(200, { "Content-Type": "application/json" }).end(list); return; }
    const file = served.get(at);
    if (!file) { res.writeHead(404).end("not found"); return; }
    const size = fs.statSync(file).size;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m ? Math.min(Number(m[1]), size) : 0;
    res.writeHead(m ? 206 : 200, { "Content-Length": size - start, ...(m ? { "Content-Range": `bytes ${start}-${size - 1}/${size}` } : {}) });
    if (start >= size) { res.end(); return; }
    fs.createReadStream(file, { start }).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  list = JSON.stringify(downloadsList(base, files));
  return {
    base,
    env: { MYCOMAP_VALIDATION_DOWNLOADS: `${base}/api/downloads`, MYCOMAP_VALIDATION_BLAST_MIRROR: `${base}/blast/` },
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
