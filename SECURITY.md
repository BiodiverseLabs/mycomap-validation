# Security

## Reporting a problem

Please report security problems privately, not in a public issue: email
**info@mycomap.org** with "MycoMap Validation security" in the subject, or use
GitHub's private vulnerability reporting on this repository. Include what you
found, how to reproduce it, and what it affects. We aim to reply within a week.

## What this repository holds, and what it doesn't

The rules and their tests are here. These are not, and never will be:

- **Recorded decisions from mycomap.org.** mycomap.org records what its
  analyses and decisions were asked and answered, to check each change to the
  rules. Those recordings hold members' record details, so they stay private.
  The test cases here are built by hand.
- **Locations.** Records can hold the true coordinates of observations that are
  obscured on iNaturalist, often for rare or sensitive species. No part of this
  project may publish them or make them recoverable.
- **Settings and credentials.** The rules take none: they make no outside
  call.
