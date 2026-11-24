# Instructions for coding agents

This file is for AI coding agents working in this repository. People should read [CONTRIBUTING.md](CONTRIBUTING.md), which covers the same ground with more context.

OAFactory decides whether agent-written changes are safe to merge. You are working on the thing that judges work like yours, so the bar for honesty and tests here is high.

## Commands

Run from the repository root. Node.js 22.13 or later.

```bash
npm install
npm test            # all tests; must pass before you finish
npm run typecheck   # must pass before you finish
npm run build       # compiles packages/oafactory to dist/
npm run build -w web    # builds the site; run it if you touched apps/web or docs
node packages/oafactory/dist/bin.js demo   # end-to-end smoke test, after a build
```

Run one test file: `npx vitest run test/core.test.ts` from `packages/oafactory`.

## Layout

| Path | Contents |
|---|---|
| `packages/oafactory/src/` | The CLI and library |
| `packages/oafactory/test/` | Tests. `conformance-*.test.ts` are named after spec IDs (C1.1 to C3.8) |
| `apps/web/` | Next.js site. Renders `docs/` at `/docs` |
| `docs/` | MDX documentation. Navigation is `docs/docs.json` |
| `spec/oafactory-spec-v0.1.md` | The specification. The source of truth for behaviour |

Key modules in `packages/oafactory/src/`:

| File | Role |
|---|---|
| `classify.ts`, `paths.ts`, `config.ts` | Tier classification and config schema. Pure functions |
| `evidence.ts`, `gate.ts`, `standing.ts` | Evidence collection, the decision procedure, promotion and demotion |
| `ledger.ts`, `receipt.ts` | Append-only SQLite Ledger; in-toto statements and DSSE signing |
| `watcher.ts`, `scoreboard.ts` | Post-merge watching; metrics |
| `harness.ts`, `workspace.ts`, `sandbox.ts`, `gateway.ts`, `reviewer.ts`, `instructions.ts` | Running an agent: checkout, sandbox, budgeted model access, review |
| `host/` | `Host` interface, with GitHub, GitLab and in-memory implementations |
| `cli.ts`, `init.ts`, `ready.ts`, `demo.ts` | Commands |

## Rules

1. **The spec decides behaviour.** If the code and `spec/oafactory-spec-v0.1.md` disagree, do not quietly pick one. Follow the spec, or record the departure in `docs/reference/status.mdx` and say so in your summary.
2. **Never weaken a test to make it pass.** Do not edit, skip or delete an existing test to get a green run. Existing files under `packages/oafactory/test/` are append-only: add new tests, and if an existing one is wrong, say so and leave the change to a person.
3. **Every behaviour change needs a test.** A change to a conformance behaviour needs a test named after its spec ID.
4. **Keep the trust boundaries.** Do not add code that passes a Git host token, a provider key or a role token into the Sandbox; that lets the Worker influence its tier or its evidence; that reads evidence from a change description or agent output; or that writes to the Ledger other than by appending.
5. **Say what you did not verify.** Do not claim something works against live GitHub, GitLab, Docker, Sigstore or a model provider unless you ran it. Unverified areas are listed in `docs/reference/status.mdx`; keep that page accurate.
6. **No new runtime dependencies** in `packages/oafactory` without a stated reason. It has two (`yaml`, `zod`) on purpose.
7. **Stay in scope.** Make the change you were asked for. Report unrelated problems instead of fixing them in the same change.

## Paths that need a person

This repository gates itself with `.oafactory/factory.yaml`. Changes to these are Tier 3 and will not be merged without human review, so do not touch them unless the task is specifically about them:

- `.oafactory/`, `.github/`, `spec/`, `LICENSE`
- `package.json` files, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`, `next.config.mjs`
- `AGENTS.md`, `CLAUDE.md` and any other agent instruction file
- The decision core: `gate.ts`, `classify.ts`, `evidence.ts`, `standing.ts`, `ledger.ts`, `receipt.ts`, `paths.ts`, `config.ts`
- Existing test files

## Style

- TypeScript, strict mode, ES modules. Import local files with a `.js` extension.
- Prefer pure functions with injected dependencies (`now`, `random`, `host`) so behaviour can be tested without a network.
- Comments explain why, not what. Quote the spec's wording where a line implements a MUST.
- Error messages say what to do next.
- Docs are plain Markdown in `.mdx` files: keep `{` and `<` inside code spans or code blocks. The only components used are `<Note>` and `<Warning>`.

## Commits and pull requests

- Never commit to `main` and never push to it. Create a feature branch named `type/short-description` (for example `fix/gate-head-moved`) from the latest `main`, and open a pull request. It is squash-merged automatically once the `typecheck`, `test`, `web` and `conventional` checks are green.
- One change per branch. Rebase onto `main` if it moves; do not merge `main` into your branch.
- [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`. Scopes: `gate`, `ledger`, `harness`, `gateway`, `host`, `cli`, `web`, `docs`, `spec`.
- A breaking change to the config, receipt format or CLI gets `!` after the type and a `BREAKING CHANGE:` footer.
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user would notice.
- In the pull request, list what you ran and what you could not verify. If an AI agent wrote the change, say which one.
