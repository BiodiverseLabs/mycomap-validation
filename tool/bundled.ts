// What the downloadable build carries inside its one file (tool/release/build.ts
// writes it in): the engine's version and the browser page's files, so the
// tool needs nothing beside it. Null when the tool runs from the source, which
// reads them from disk.
export interface Bundled {
  version: string;
  /** The page's files by name ("index.html", "app.js", …), as text. */
  page: Record<string, string>;
}

// The cast keeps TypeScript from reading this as always null.
export const bundled = null as Bundled | null;
