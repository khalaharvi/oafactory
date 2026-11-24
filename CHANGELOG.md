# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0, a minor release may contain breaking changes.

## [Unreleased]

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

### Known limitations

- The GitHub and GitLab adapters, the Docker sandbox, Sigstore signing and the built-in agent command lines have not been run against live services.
- No Postgres Ledger backend and no `pr-agent` Reviewer adapter yet.
- See [Status and limits](docs/reference/status.mdx) for the full list, including where the implementation departs from the spec.

[Unreleased]: https://github.com/khalaharvi/oafactory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/khalaharvi/oafactory/releases/tag/v0.1.0
