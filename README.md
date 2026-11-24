# OAFactory

**An open software factory.** Agents write the changes. A deterministic Gate decides what merges, from evidence it collects itself. Every run leaves a receipt.

[![CI](https://github.com/khalaharvi/oafactory/actions/workflows/ci.yml/badge.svg)](https://github.com/khalaharvi/oafactory/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196.svg)](https://www.conventionalcommits.org)

> **Status: 0.1 alpha.** The decision logic, Ledger, Gateway and Harness are covered by 59 tests. The GitHub and GitLab adapters, the Docker sandbox and Sigstore signing are written but have not been run against live services yet. Start in shadow mode, and read [Status and limits](docs/reference/status.mdx) before relying on anything.

Coding agents can write a change in minutes. The slow part is deciding whether it is safe to merge. OAFactory is that decision, written down as code:

- **The author never judges its own work.** The agent runs in a sandbox with no Git credential. It cannot push, merge or set its own risk tier, and nothing it says about its work counts as evidence.
- **Risk comes from the diff.** A tier from 0 to 3 is computed from the paths a change touches and the config on the base branch. No model is involved.
- **Autonomy is earned.** The Gate starts in shadow mode, recording what it would have merged while people keep merging. A tier earns automatic merging after a track record, and loses it after one revert.
- **Every run has a receipt.** An in-toto statement that records the tier, the evidence, the cost, the decision, and what could not be verified.

## Try it

Requires Node.js 22.13 or later.

```bash
git clone https://github.com/khalaharvi/oafactory
cd oafactory
npm install
npm run build
npm link -w oafactory

oafactory demo
```

The demo walks through the whole lifecycle on an in-memory Git host. It needs no account, no keys and no network.

```
2. Things an agent might try
  ESCALATE    tier 3  rewrites the Makefile so `make test` always passes
              Tier 3 always goes to a person (Makefile matched protected Makefile).
  ESCALATE    tier 3  edits an existing test to make it pass
              Tier 3 always goes to a person (tests/test_config.py exists on the base branch under append-only tests/).
  ESCALATE    tier 0  says "all checks passed" in the description; they did not
              Tier 0 bar not met; missing evidence: checks.
```

Then, in a repository of your own:

```bash
oafactory init        # write .oafactory/factory.yaml, in shadow mode
oafactory ready       # check that it protects what it must
oafactory classify    # see the tier of your local changes
oafactory gate 431    # evaluate a pull request and write its receipt
```

## How it works

```
work order -> [ Sandbox: Runner ] -> Harness -> Reviewer -> Gate -> Ledger
                no Git credential     pushes     fresh       merges      |
                no provider key       branch     context     or          v
                                                             escalates  Watcher -> revert, demote
```

| Tier | Typical content | When the evidence bar is met |
|---|---|---|
| 0 | Documentation | Merges, once the tier has standing |
| 1 | Source code with a new test | Merges, once the tier has standing |
| 2 | Unclassified, or too large for its tier | Goes to a person, with the evidence attached |
| 3 | CI, factory config, existing tests, agent instruction files | Goes to a person, always |

The full design is in the [specification](spec/oafactory-spec-v0.1.md).

## Documentation

| | |
|---|---|
| [Quickstart](docs/quickstart.mdx) | Install, run the demo, gate a repository |
| [How it works](docs/concepts/how-it-works.mdx) | Roles and trust boundaries |
| [Tiers](docs/concepts/tiers.mdx), [Evidence](docs/concepts/evidence.mdx), [Standing](docs/concepts/standing.mdx), [Receipts](docs/concepts/receipts.mdx) | The concepts |
| [Shadow mode on GitHub](docs/guides/shadow-mode-github.mdx) | Test reports and running the Gate after CI |
| [Running agents](docs/guides/running-agents.mdx) | Gateway, Sandbox, work orders |
| [Earned mode](docs/guides/earned-mode.mdx) | What must be true before the Gate merges |
| [CLI](docs/reference/cli.mdx), [Factory config](docs/reference/factory-config.mdx), [Conformance](docs/reference/conformance.mdx) | Reference |
| [Status and limits](docs/reference/status.mdx) | What is verified, what is not, and where the code departs from the spec |

## Repository layout

| Path | What it is |
|---|---|
| `packages/oafactory/` | The CLI and library (TypeScript). Two runtime dependencies: `yaml` and `zod` |
| `packages/oafactory/test/` | Unit tests and the conformance suite, named after the spec's IDs (C1.1 to C3.8) |
| `apps/web/` | Marketing site and docs site (Next.js), deployable to Vercel |
| `docs/` | Documentation as MDX. Rendered by `apps/web` at `/docs`, and ready for Mintlify (`docs/docs.json`) |
| `spec/` | The specification this implements |
| `examples/` | A work order and CI workflow snippets |
| `.oafactory/factory.yaml` | The config this repository gates itself with |

## Development

```bash
npm install
npm test             # 59 tests, about 4 seconds
npm run typecheck
npm run build
npm run web          # the site, at http://localhost:3000
```

### Deploying the site

Import the repository in Vercel and set the project's **Root Directory** to `apps/web`. The build reads `docs/` from the repository root, so leave "Include files outside the root directory" enabled (the default).

To host the docs on Mintlify instead, connect the repository in Mintlify and set the docs directory to `docs`.

## Contributing

Contributions are welcome, from people and from agents. Start with [CONTRIBUTING.md](CONTRIBUTING.md); agents should read [AGENTS.md](AGENTS.md). We use [Conventional Commits](https://www.conventionalcommits.org), and changes are recorded in the [changelog](CHANGELOG.md).

Please report security problems privately: see [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
