# Security policy

OAFactory exists to keep untrusted, agent-written changes from merging unchecked. A flaw in it can be a flaw in every repository that relies on it, so we treat these reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting: on the repository's **Security** tab, choose **Report a vulnerability**.

Please include what you did, what happened, what you expected, and the version (`oafactory --version`). A failing test is the best possible report.

We aim to acknowledge a report within 7 days. This is a small project with no dedicated security team, so please allow reasonable time for a fix before disclosing.

## What counts

Anything that breaks a guarantee in the [specification](spec/oafactory-spec-v0.1.md), for example:

- A change is given a lower tier than the classification procedure produces.
- Something the Worker wrote (a description, a comment, a file in the change) is accepted as evidence.
- A change can alter the config or the instruction files it is judged by.
- A Git host credential, a provider key or a role token becomes readable inside the Sandbox.
- Code controlled by the Worker runs outside the Sandbox, for instance through a git hook or filter.
- The Sandbox reaches a host that is not on the egress allowlist.
- The Gate merges without a stored receipt, or merges a commit other than the one it evaluated.
- A Ledger record is modified or deleted.
- A run spends well beyond its budget.

## Known limits

These are documented weaknesses of the design, not vulnerabilities. See [Status and limits](docs/reference/status.mdx).

- Passing checks does not mean a change is correct.
- Model review misses most defects.
- A new file can change the behaviour of existing tests in some frameworks.
- The local sandbox (`--sandbox local`) is not containment and says so.
- Prompt injection is mitigated by the trust boundaries, not eliminated.

## Supported versions

Only the latest release receives fixes while the project is below 1.0.
