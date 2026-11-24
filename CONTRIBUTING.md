# Contributing to OAFactory

Thank you for helping. This project is young, and the most useful contributions right now are reports from real use: a repository where `oafactory init` guessed wrong, a GitHub or GitLab response the adapter mishandles, a way to get a change past the Gate that should not get past it.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

| | |
|---|---|
| **Report a bug** | Open an issue with the bug template. Include the command, the output and `oafactory --version` |
| **Report a bypass** | If you can make the Gate merge or mis-tier something it should not, that is a security report. See [SECURITY.md](SECURITY.md) and do not open a public issue |
| **Verify something unverified** | [Status and limits](docs/reference/status.mdx) lists what has not been run against live services. Running one and reporting the result is a real contribution |
| **Propose a spec change** | Open an issue with the proposal template before writing code. Behaviour follows the spec |
| **Fix or improve** | Small fixes can go straight to a pull request. For anything larger, open an issue first so we can agree on the approach |

## Set up

You need Node.js 22.13 or later and git.

```bash
git clone https://github.com/khalaharvi/oafactory
cd oafactory
npm install
npm test
```

| Command | What it does |
|---|---|
| `npm test` | Runs every test, including the conformance suite |
| `npm run typecheck` | Type-checks the package |
| `npm run build` | Compiles `packages/oafactory` to `dist/` |
| `npm run web` | Runs the site at http://localhost:3000 |
| `node packages/oafactory/dist/bin.js demo` | End-to-end smoke test, after a build |

## Making a change

`main` is protected. Nothing is pushed to it directly, by anyone: every change arrives through a pull request, and merges only when CI is green.

1. Fork the repository (maintainers can branch in place) and create a feature branch from the latest `main`. Name it `type/short-description`, using the same types as commit messages:

   ```bash
   git switch main && git pull
   git switch -c fix/gate-head-moved
   ```

2. Make the change, with tests. A behaviour change without a test will be sent back.
3. Run `npm test` and `npm run typecheck`. If you touched `apps/web` or `docs`, run `npm run build -w web` too.
4. Add a line to `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) if a user would notice the change.
5. Commit using [Conventional Commits](#commit-messages), push the branch and open a pull request. Fill in the template.
6. Turn on auto-merge. The pull request is squash-merged as soon as every required check passes, and the branch is deleted:

   ```bash
   gh pr create --fill
   gh pr merge --auto --squash
   ```

Keep a branch to one change. If `main` moves, rebase onto it rather than merging it in; history on `main` is linear.

### Required checks

| Check | What it runs |
|---|---|
| `typecheck` | `npm run typecheck` |
| `test` | The full test suite, including the conformance suite |
| `web` | A production build of the site and docs |
| `conventional` | The pull request title follows Conventional Commits |

The protection rules are recorded in [`.github/branch-protection.json`](.github/branch-protection.json). A maintainer with admin rights applies them with:

```bash
gh api -X PUT repos/khalaharvi/oafactory/branches/main/protection --input .github/branch-protection.json
```

### What we look for in review

- **It follows the spec**, or it says where it departs and updates [Status and limits](docs/reference/status.mdx).
- **Tests were added, not edited.** Existing tests are append-only here, for the same reason they are in the factory: a change should not be able to redefine what passing means.
- **Trust boundaries hold.** No credential reaches the Sandbox. Nothing the Worker says is treated as evidence. The Ledger is only appended to.
- **Claims are accurate.** Say what you ran. Say what you could not run.

Changes to the decision core (`gate.ts`, `classify.ts`, `evidence.ts`, `standing.ts`, `ledger.ts`, `receipt.ts`), to CI, or to the factory config always get a maintainer's review. That is this repository applying its own Tier 3 rule.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org). The pull request title must follow it too, because pull requests are squash-merged and the title becomes the commit.

```
type(scope): short summary in the imperative

Optional body explaining why.

BREAKING CHANGE: what breaks and how to migrate   (only when needed)
```

| Type | Use for |
|---|---|
| `feat` | A new capability |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Adding tests |
| `refactor` | A change that neither fixes a bug nor adds a feature |
| `perf` | A performance improvement |
| `build`, `ci`, `chore` | Tooling, CI, housekeeping |

Scopes: `gate`, `ledger`, `harness`, `gateway`, `host`, `cli`, `web`, `docs`, `spec`. Examples:

```
feat(host): read test reports from GitLab pipelines
fix(gate): restart evaluation when the head moves during the audit draw
docs: explain why Tier 1 needs a rule for new test files
feat(cli)!: rename --ledger to --ledger-path
```

CI checks the title of every pull request.

## Contributions from AI agents

Agent-written pull requests are welcome, and held to the same standard as any other.

- Point your agent at [AGENTS.md](AGENTS.md). Claude Code reads it through `CLAUDE.md`.
- A person must open the pull request, have read the diff, and be able to answer questions about it.
- Say in the pull request which agent wrote the change.
- Do not add or edit agent instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, and so on) as part of another change. Those go in their own pull request.

## Versioning and releases

OAFactory follows [Semantic Versioning](https://semver.org). While the version is below 1.0 and the API is `v1alpha1`, a minor release may break the config, the receipt format or the CLI; the changelog will say so.

Maintainers release by:

1. Moving the `Unreleased` entries in `CHANGELOG.md` under a new version heading with the date.
2. Setting the same version in `packages/oafactory/package.json`, `packages/oafactory/src/cli.ts` and `apps/web/lib/site.ts`.
3. Committing as `chore(release): vX.Y.Z` and pushing a `vX.Y.Z` tag.

The tag starts the release workflow, which runs the tests and publishes a GitHub release with that version's changelog entry.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
