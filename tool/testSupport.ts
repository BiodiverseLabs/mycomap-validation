// For the tool's tests: writes small tar archives, and serves files over
// HTTP on this computer (with Range requests, and a way to cut a download
// short), so init can be tried without the internet. With handlers it also
// stands in for a service (MycoMap Vision's API), answering each request as
// the test says.
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

export interface TarEntry {
  name: string;
  /** Text or bytes; a name ending in "/" is a folder. */
  body?: string | Buffer;
  /** Write the name as a GNU long name record, as GNU tar does for names over 100 characters. */
  longName?: boolean;
}

/** A tar archive (gzipped unless `gzip: false`). */
export function tarGz(entries: TarEntry[], opts: { gzip?: boolean; cutAt?: number } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = typeof e.body === "string" ? Buffer.from(e.body) : e.body ?? Buffer.alloc(0);
    const isDir = e.name.endsWith("/");
    if (e.longName) {
      const name = Buffer.from(`${e.name}\0`);
      parts.push(header("././@LongLink", name.length, "L"), padded(name));
    }
    parts.push(header(e.longName ? e.name.slice(0, 99) : e.name, isDir ? 0 : body.length, isDir ? "5" : "0"));
    if (!isDir) parts.push(padded(body));
  }
  parts.push(Buffer.alloc(1024));
  let tar = Buffer.concat(parts);
  if (opts.cutAt !== undefined) tar = tar.subarray(0, opts.cutAt);
  return opts.gzip === false ? tar : zlib.gzipSync(tar);
}

/** A request a handler answers. */
export interface ServedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/** A handler's answer: its status, headers, and body (an object is sent as JSON). */
export interface ServedAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type Handler = (req: ServedRequest) => ServedAnswer | Promise<ServedAnswer>;

export interface Served {
  base: string;
  /** Each request: its method, path, Range header and, for a handler, the rest of it. */
  requests: Array<{ path: string; range: string | null; method?: string; headers?: http.IncomingHttpHeaders; body?: Buffer }>;
  /** Files by path; change them between tries. */
  files: Map<string, Buffer | string>;
  /** Paths whose next download is cut off after this many bytes. */
  cutOnce: Map<string, number>;
  close(): Promise<void>;
}

/**
 * Serves `files` on 127.0.0.1, answering Range requests as a file server does.
 * A path in `handlers` ("POST /api/v1/identify", or a path for any method) is
 * answered by its handler instead.
 */
export async function serve(files: Record<string, Buffer | string>, handlers: Record<string, Handler> = {}): Promise<Served> {
  const state = { files: new Map(Object.entries(files)), cutOnce: new Map<string, number>(), requests: [] as Served["requests"] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const range = req.headers.range ?? null;
    const handler = handlers[`${req.method} ${url.pathname}`] ?? handlers[url.pathname];
    if (handler) {
      const parts: Buffer[] = [];
      for await (const chunk of req) parts.push(chunk as Buffer);
      const request = { method: req.method ?? "GET", path: url.pathname, headers: req.headers, body: Buffer.concat(parts) };
      state.requests.push({ ...request, range });
      try {
        const answer = await handler(request);
        const json = answer.body !== undefined && typeof answer.body !== "string" && !Buffer.isBuffer(answer.body);
        res.writeHead(answer.status, { ...(json ? { "Content-Type": "application/json" } : {}), ...answer.headers });
        res.end(json ? JSON.stringify(answer.body) : (answer.body as string | Buffer | undefined) ?? "");
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
      return;
    }
    state.requests.push({ path: url.pathname, range });
    const file = state.files.get(url.pathname);
    if (file === undefined) { res.writeHead(404).end("not found"); return; }
    const body = Buffer.isBuffer(file) ? file : Buffer.from(file);
    const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
    const start = m ? Number(m[1]) : 0;
    const slice = body.subarray(start);
    res.writeHead(m ? 206 : 200, { "Content-Length": slice.length, ...(m ? { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    const cut = state.cutOnce.get(url.pathname);
    if (cut !== undefined) {
      state.cutOnce.delete(url.pathname);
      res.write(slice.subarray(0, cut));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    ...state,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export interface NcbiCall {
  method: string;
  /** The address's parameters (CMD=Get's, and the api_key on a Put). */
  query: Record<string, string>;
  /** A Put's form body. */
  body: Record<string, string>;
}

/** E-utilities' einfo answer for a key it takes (cut down). */
export const EINFO_OK = JSON.stringify({ header: { type: "einfo", version: "0.3" }, einforesult: { dblist: ["pubmed", "nuccore"] } });

export interface StandInNcbi {
  /** The BLAST URL API's address on this computer. */
  url: string;
  calls: NcbiCall[];
  /** The key checks (E-utilities einfo), kept apart from the BLAST requests. */
  keyChecks: NcbiCall[];
  close(): Promise<void>;
}

/**
 * Stands in for NCBI's BLAST URL API (Blast.cgi) on 127.0.0.1: each request
 * is recorded and answered by `answer`, so the refresh can be tried without
 * ever reaching NCBI.
 */
export async function standInNcbi(
  answer: (call: NcbiCall, index: number) => { status?: number; body: string },
  keyCheck: (call: NcbiCall) => { status?: number; body: string } = () => ({ body: EINFO_OK }),
): Promise<StandInNcbi> {
  const calls: NcbiCall[] = [];
  const keyChecks: NcbiCall[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const call: NcbiCall = {
        method: req.method ?? "GET",
        query: Object.fromEntries(url.searchParams),
        body: Object.fromEntries(new URLSearchParams(Buffer.concat(parts).toString("utf8"))),
      };
      if (url.pathname === "/entrez/eutils/einfo.fcgi") {
        keyChecks.push(call);
        const reply = keyCheck(call);
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" }).end(reply.body);
        return;
      }
      calls.push(call);
      const reply = url.pathname === "/Blast.cgi" ? answer(call, calls.length - 1) : { status: 404, body: "not found" };
      res.writeHead(reply.status ?? 200, { "Content-Type": "text/html" }).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/Blast.cgi`,
    calls,
    keyChecks,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** NCBI's answer to a Put. */
export function qblastPut(rid: string, rtoe = 30): string {
  return `<html><!--QBlastInfoBegin\n    RID = ${rid}\n    RTOE = ${rtoe}\nQBlastInfoEnd\n--></html>`;
}

/** NCBI's answer to a Get while the search runs, or when it is done with no hits. */
export function qblastStatus(status: "WAITING" | "FAILED" | "UNKNOWN" | "READY", thereAreHits?: "yes" | "no"): string {
  return `<html><!--QBlastInfoBegin\n\tStatus=${status}\n${thereAreHits ? `\tThereAreHits=${thereAreHits}\n` : ""}QBlastInfoEnd\n--></html>`;
}

/** A BLAST XML answer, shaped as NCBI writes it, with one HSP a hit. */
export function blastXml(queryLen: number, hits: Array<{ accession: string; def: string; identity: number; alignLen: number; queryFrom?: number; queryTo?: number; qseq?: string; hseq?: string }>): string {
  const hit = (h: (typeof hits)[number], i: number) => `
<Hit>
  <Hit_num>${i + 1}</Hit_num>
  <Hit_id>gb|${h.accession}|</Hit_id>
  <Hit_def>${h.def}</Hit_def>
  <Hit_accession>${h.accession.replace(/\.\d+$/, "")}</Hit_accession>
  <Hit_len>${h.alignLen + 20}</Hit_len>
  <Hit_hsps>
    <Hsp>
      <Hsp_num>1</Hsp_num>
      <Hsp_bit-score>900</Hsp_bit-score>
      <Hsp_query-from>${h.queryFrom ?? 1}</Hsp_query-from>
      <Hsp_query-to>${h.queryTo ?? h.alignLen}</Hsp_query-to>
      <Hsp_hit-from>11</Hsp_hit-from>
      <Hsp_hit-to>${h.alignLen + 10}</Hsp_hit-to>
      <Hsp_identity>${h.identity}</Hsp_identity>
      <Hsp_align-len>${h.alignLen}</Hsp_align-len>
      <Hsp_qseq>${h.qseq ?? ""}</Hsp_qseq>
      <Hsp_hseq>${h.hseq ?? ""}</Hsp_hseq>
      <Hsp_midline></Hsp_midline>
    </Hsp>
  </Hit_hsps>
</Hit>`;
  return `<?xml version="1.0"?>
<!DOCTYPE BlastOutput PUBLIC "-//NCBI//NCBI BlastOutput/EN" "http://www.ncbi.nlm.nih.gov/dtd/NCBI_BlastOutput.dtd">
<BlastOutput>
  <BlastOutput_program>blastn</BlastOutput_program>
  <BlastOutput_db>nr</BlastOutput_db>
  <BlastOutput_query-len>${queryLen}</BlastOutput_query-len>
  <BlastOutput_iterations>
<Iteration>
  <Iteration_iter-num>1</Iteration_iter-num>
  <Iteration_query-len>${queryLen}</Iteration_query-len>
  <Iteration_hits>${hits.map(hit).join("")}
  </Iteration_hits>
</Iteration>
  </BlastOutput_iterations>
</BlastOutput>`;
}
