# Contributing

Thank you for looking. A few rules keep MycoMap Validation trustworthy.

## The rules reach nothing outside themselves

Nothing in `src/` may use the network, a database, the file system, the
clock, the environment or the console, or import anything outside `src/`.
Whatever a rule needs from outside is asked through a port the caller hands
in. `test/engineReachesNothingOutside.test.ts` checks this.

## Every change comes with tests

- A change to what a rule decides comes with tests that show the new decision,
  and the old one where it differs.
- A bug fix comes with a test that fails without the fix.
- Name a test after the rule it protects, not the function it calls.

Run `pnpm run typecheck` and `pnpm test` before opening a pull request.

## Rule changes get their own release

Every change to a rule gets its own release number (see
[CHANGELOG.md](CHANGELOG.md)). A rule change is reviewed and checked against
the test cases before mycomap.org adopts it. mycomap.org also replays the
decisions it made on real records against the new version; those recordings
hold members' record details, so they are kept private and are not part of
this repository.

## How a change gets in

The rules and the tool are worked on inside mycomap.org, beside the code that calls them,
so that a rule change and the replays that check it happen in one place.
Every commit on `main` here is a release published from there, and says
which mycomap.org commit it came from ("Exported from mycomap.org …").

So a pull request here is not merged as it is. When it is accepted:

1. it is reviewed, and checked against the test cases and against
   mycomap.org's replays of past decisions;
2. the change is applied to mycomap.org's copy, with your name
   kept on it;
3. it is published here in the next release, and the pull request is closed
   with a link to that commit.

Issues are welcome for anything you think a rule gets wrong; a record that
shows it (an iNaturalist or Mushroom Observer observation number) helps most.

## Data

Do not add real record details, coordinates, member names, keys or addresses
to the code or the tests. Test cases are built by hand or cleaned and
checked before they are added.
