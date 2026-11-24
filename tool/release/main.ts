// Where the downloadable tool starts (tool/release/build.ts bundles from here):
// the same command line as `pnpm tool`.
import { runCommandLine } from "../cli";

runCommandLine(process.argv.slice(2));
