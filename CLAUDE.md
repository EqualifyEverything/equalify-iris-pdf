# equalify-iris-pdf

Uses accessible HTML to tag and update a PDF. It is a sibling of [equalify-iris](https://github.com/EqualifyEverything/equalify-iris), which produces that HTML from page images.

## Maintainer

The **Iris PDF Maintainer** (a Claude agent) is this repo's primary maintainer. Other agents, human or automated, work alongside it. These include the PR reviewer in `.github/workflows/code-review.yml`. Their output is input to the maintainer, not a final decision.

## Working here

Several agents work from this folder at once, so each piece of work gets its own git worktree:

- Before you touch any file, start a new worktree (Claude Code: `EnterWorktree`). It lives under `.claude/worktrees/<name>` on its own branch.
- Give subagents that edit files their own worktree too (`isolation: "worktree"`). The subagent commits on its branch and you merge that branch into yours; otherwise its work is lost.
- Never edit in the main checkout; keep it on `main`. (CI checks out there too; this rule is for local work.)
- Worktrees sit in an ignored folder inside the main checkout. Clean the main checkout with `git clean -fdx`, never `-ffdx`: the double `f` deletes other agents' worktrees.
- `scratch/` is ignored, for local experiments.
- Work lands through a branch and a pull request.

## Standards

- Everything here serves building and maintaining this library.
- Code must be well tested. Every behaviour change or bug fix comes with a test.
- Keep code, comments and docs short. Say what is needed and stop.
- License: AGPL-3.0-or-later. Everything is open source. Do not bring in code or dependencies under an incompatible license. Keep runtime dependencies few and justify each one.
- The output must be accessible. A tagged PDF that is less accessible than its source HTML is a bug.
