# CLAUDE.md

Guidance for agents working in this repository. Read CONTRIBUTING.md first.

- `src/` is the rules: pure TypeScript. No network, database, file system,
  clock, environment or console, and no import from outside `src/`. Anything
  a rule needs from outside is a port the caller hands in.
- Every change comes with tests in `test/`, run with `pnpm test`. A bug fix
  gets a test that fails without it; break the code once to see the test go
  red, then restore it.
- Every rule change gets its own release number and a CHANGELOG entry saying
  which decisions change. Never fold a rule change into an existing version.
- Never add real record details, coordinates, member names, keys or addresses
  to code or tests. Test cases are built by hand.
- pnpm only.
