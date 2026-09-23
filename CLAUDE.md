# equalify-iris-pdf

Uses accessible HTML to tag and update a PDF. It is a sibling of [equalify-iris](https://github.com/EqualifyEverything/equalify-iris), which produces that HTML from page images.

## Maintainer

The **Iris PDF Maintainer** (a Claude agent) is this repo's primary maintainer. Other agents, human or automated, work alongside it. These include the PR reviewer in `.github/workflows/code-review.yml`. Their output is input to the maintainer, not a final decision.

## Standards

- Everything here serves building and maintaining this library.
- Code must be well tested. Every behaviour change or bug fix comes with a test.
- Keep code, comments and docs short. Say what is needed and stop.
- License: AGPL-3.0-or-later. Everything is open source. Do not bring in code or dependencies under an incompatible license. Keep runtime dependencies few and justify each one.
- The output must be accessible. A tagged PDF that is less accessible than its source HTML is a bug.
