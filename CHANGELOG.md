# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0, a minor release may contain breaking changes.

## [Unreleased]

### Added

- This repository ships a `.mcp.json`, so Claude Code offers the OAFactory MCP server to anyone working in it, after they approve it.
- MCP server lists (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`) are treated as agent instruction files. `oafactory init` protects them, `oafactory ready` checks for them, and one added by a change is removed before the Runner or Reviewer loads the checkout.
- Newer Node features are used inside the Sandbox when the image has them. From Node 26 the built-in Runner starts under Node's permission model, limiting its own file access to the project. From Node 24, Node programs in the Sandbox honour the proxy settings and reach allowlisted hosts through the Gateway. The default sandbox image is now `node:26-slim`. OAFactory itself still runs on Node 22.13 or later.
- An MCP server, `oafactory-mcp`, built on version 2 of the MCP TypeScript SDK. From Claude or any other MCP client you can read a project's factory rules, draft a work order and see in plain words what it would do, save it, and follow its result. Starting a run from the assistant is off unless the server is given `--allow-run`.
- `oafactory explain <work-order.yaml>` now ends with notes worth knowing before the run, such as a scope that allows code changes but not the tests they need.
- `oafactory explain <work-order.yaml>` and `oafactory explain <receipt-id>`: what will happen, or what happened, in plain words for people who are not engineers. Built from fixed wording, with no model involved.
- `oafactory run "<what you want done>"`: start a run from a sentence, without writing a work order file. The run prints its plain-language explanation before it starts.
- Docs: "A work order, in plain words" and "Free and open", and matching sections on the site.

- A built-in Runner (`roles.runner.use: builtin`): OAFactory's own small coding agent, with file and command tools, for Anthropic-style and OpenAI-style APIs. It needs only Node in the Sandbox image, so `node:22-slim` is now the default image and `oafactory init` selects it.

- Docs: a troubleshooting guide, written from the first run of the factory against its own repository.

### Fixed

- A test report that cannot be downloaded no longer stops the Gate. It is recorded as missing `test_integrity` evidence with the cause, and the change is still decided and given a receipt. Found by running the factory against its own repository.
- When the Gate fails after a change has been opened, the run stays recorded and the error says how to resume with `oafactory gate <change>`.
- Command errors are shortened and drop URL query strings, which can carry signed URLs.
- Piping output into a command that exits early, such as `head`, no longer prints a stack trace.

### Changed

- The receipt comment on a change, and `oafactory explain`, say which evidence the change's tier requires, so a low-risk change is not shown as failing checks it never needed.

- The GitHub adapter opens changes, comments and merges through the REST API, so it no longer needs GraphQL access. Merges are pinned with the API's `sha` parameter.
- `oafactory conformance --live` needs only Node in the image, and C1.1 now includes a positive control: the Gateway must be reachable, so a Sandbox with no network at all cannot pass by accident.
- The Docker sandbox runs the Worker as the Harness's user, so the files it leaves are not owned by root.
- `oafactory explain <receipt>` lists evidence the risk level does not require separately, so a low-risk change is no longer shown as failing checks it never needed.
- The README now leads with a banner, a capture of the demo and a flow diagram.
- Status page: the GitHub adapter's read paths have been run against live GitHub.

## [0.1.0] - 2026-11-24

The first release. It implements all eight build steps of specification v0.1, draft revision 2.

### Added

- **Factory config and tier classifier.** The full `oafactory/v1alpha1` schema, path patterns, and the deterministic classification procedure of spec section 4.
- **`oafactory init` and `oafactory ready`.** Draft a shadow-mode config from a repository, and check that it protects CI, check scripts, tests and agent instruction files.
- **Evidence and the Gate.** Collection of `checks`, `budget`, `test_integrity`, `new_test`, `holdout`, `review` and `behavior` evidence from their sources; the eight-step decision procedure; merges pinned to the evaluated commit; one rerun for a failed check.
- **Receipts.** In-toto v1 statements, written before any merge, with DSSE signing through a local Ed25519 key or Sigstore.
- **Ledger.** An append-only SQLite store for receipts, outcomes and standing, with JSON Lines export and a scoreboard.
- **Standing.** Shadow mode, agreement tracking, promotion confirmed by a person, audit sampling from the OS random source, and demotion on revert.
- **Host adapters** for GitHub (`gh`) and GitLab (`glab`), and an in-memory host for tests and the demo.
- **Harness.** Credential-free checkouts, commits through a pristine git directory, base-branch instruction files, attempts and abandoned runs.
- **Gateway.** Per-run budgeted keys, model aliases, usage metering for Anthropic and OpenAI-style APIs, and an HTTPS egress allowlist.
- **Sandboxes.** Docker on an internal network, and an uncontained local sandbox for development.
- **Watcher.** Rerun-once at the merge commit, automatic revert, and exact-inverse revert merging.
- **Conformance suite.** Tests named after spec IDs C1.1 to C3.8, plus live Sandbox probes (`oafactory conformance --live`).
- **`oafactory demo`.** The whole lifecycle on an in-memory Git host.
- **Marketing site and documentation**, as a Next.js app deployable to Vercel, with the docs also ready for Mintlify.

### Project

- Contributions go through feature branches and pull requests that merge when CI is green; `main` is protected by a ruleset kept in `.github/rulesets/main.json`.
- CodeQL scans every pull request.
- Releases are tagged automatically when a new version lands on `main`.

### Known limitations

- The GitHub and GitLab adapters, the Docker sandbox, Sigstore signing and the built-in agent command lines have not been run against live services.
- No Postgres Ledger backend and no `pr-agent` Reviewer adapter yet.
- See [Status and limits](docs/reference/status.mdx) for the full list, including where the implementation departs from the spec.

[Unreleased]: https://github.com/khalaharvi/oafactory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/khalaharvi/oafactory/releases/tag/v0.1.0
