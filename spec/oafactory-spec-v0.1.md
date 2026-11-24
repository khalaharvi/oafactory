# OAFactory Specification, v0.1 draft, revision 2

Date: 2026-11-21. Status: draft, not yet reviewed by anyone.
Companions: the design doc (`oasf-design-v0.2.md`) explains why; the research review (`oafactory-research-lessons.md`) gives the evidence behind the changes in this revision.

Changes in revision 2:

- Decided: per-tier promotion thresholds, a 7-day watch window, SQLite then Postgres for the Ledger, and receipts shaped as in-toto predicates with signing from v0.2.
- From the research review: the Runner holds no Git host credential; agent instruction files are read from the base branch only; `test_integrity` and `holdout` evidence; model review is no longer treated as strong evidence; audit sampling; flaky-check handling.

## 0. Conventions

- MUST, SHOULD and MAY carry their RFC 2119 meanings.
- All documents use `apiVersion: oafactory/v1alpha1`. Alpha means fields can change without notice.
- Values marked *provisional* are judgment calls until shadow-mode data exists.
- Scope: one change in one repository, from work order to merge and a watch period. Deployment, production signals and self-generated work are out of scope for this version.
- Implemented today: `oafactory ready`, and the `apiVersion`, `kind` and `protected` fields of the factory config. Everything else here is specification only.

## 1. Terms

| Term | Meaning |
|---|---|
| Change | A pull request (GitHub) or merge request (GitLab) |
| Run | One attempt to satisfy a work order, ending in exactly one receipt |
| Worker | The Runner and everything it controls inside the Sandbox |
| Harness | The fixed pipeline code outside the Sandbox that starts runs, pushes branches and opens changes |
| Check | A named CI job on the Git host whose result the Gate reads |
| Evidence | A fact about a change, produced by something other than the Worker |
| Tier | The risk class of a change, 0 (lowest) to 3 |
| Standing | Whether a repository has earned automatic merging at a tier |
| Receipt | The immutable record of a run |
| Outcome | What happened to a merged change during the watch window |
| Instruction file | A file an agent loads as instructions, such as `AGENTS.md` or `CLAUDE.md` |

## 2. Roles and trust boundaries

| Role | May | Must never |
|---|---|---|
| Sandbox | Run Worker commands; reach the Gateway and package registries | Allow other egress by default; contain any Git host credential |
| Gateway | Hold provider keys; issue one budgeted key per run | Expose provider keys to the Worker |
| Runner | Read and edit the working tree; run commands in the Sandbox | Hold any Git host credential; push; merge; set its own tier |
| Harness | Push the run's branch; open the change | Merge |
| Reviewer | Read the diff from a fresh context; return a verdict and comments | Share a model family with the Runner; see the Runner's transcript; push commits |
| Gate | Read config, diff, checks and Ledger; merge or escalate; sign receipts | Accept the Worker's claims about evidence without re-reading the source |
| Ledger | Append and serve records | Modify or delete a record; be writable by the Worker |
| Watcher | Read the default branch; rerun checks; open a revert | Merge anything other than through the Gate |
| Host | Translate the verbs in section 9 to `gh` or `glab` | |

- Three credentials MUST exist and MUST be distinct: Harness (push branch, open change), Gate (merge), Watcher (open change, rerun checks). None may be present in the Sandbox, including in the checkout's git configuration.
- The Runner, Reviewer and any other agent MUST load instruction files from the base branch only. An instruction file added or modified by the change under evaluation MUST NOT be loaded.
- The Reviewer SHOULD be a model of at least the Runner's capability class.

## 3. Factory config

Location: `.oafactory/factory.yaml`. The Gate MUST read it from the **base branch**, never from the change under evaluation.

```yaml
apiVersion: oafactory/v1alpha1
kind: Factory

protected: [.oafactory/, .github/, .gitlab-ci.yml, Makefile, AGENTS.md, CLAUDE.md]
append_only: [tests/]

checks:
  required: [lint, test]
  holdout: []

budget: { usd_per_run: 2.50, minutes_per_run: 30, max_attempts: 2 }

roles:
  runner:   { use: mini-swe-agent, model: oafactory/coder }
  reviewer: { use: pr-agent, model: oafactory/reviewer }

tiers:
  default: 2
  rules:
    - { paths: ["docs/**", "*.md"], tier: 0 }
    - { paths: ["src/**"],          tier: 1 }
    - { paths: ["install/**"],      tier: 3 }
  limits:
    0: { max_lines: 200, max_files: 10 }
    1: { max_lines: 150, max_files: 5 }

autonomy:
  mode: shadow
  promote:
    0: { after_held: 20, min_agreement: 0.95, max_reverts: 0 }
    1: { after_held: 50, min_agreement: 0.95, max_reverts: 0 }
  audit_rate: 0.10

watch: { window_hours: 168 }
```

| Field | Required | Meaning |
|---|---|---|
| `protected` | yes | Paths where any change is Tier 3 |
| `append_only` | no | Paths where new files are allowed but modifying or deleting an existing file is Tier 3 |
| `checks.required` | yes | Check names that must pass on the head commit |
| `checks.holdout` | no | Check names whose definitions live outside the repository, unreadable by the Worker |
| `budget` | yes | Hard ceilings per run; a work order may lower them, never raise them |
| `roles` | yes | Implementation and model alias for Runner and Reviewer |
| `tiers` | yes | Classification rules (section 4) |
| `autonomy.mode` | yes | `shadow` or `earned` (section 7) |
| `autonomy.promote` | no | Promotion thresholds per tier; defaults as shown, *provisional* |
| `autonomy.audit_rate` | no | Share of would-merge changes sent to a person anyway; default 0.10, *provisional* |
| `watch.window_hours` | no | Watch period after merge; default 168, *provisional* |

Path patterns: an entry ending in `/` covers a directory; any other entry is a glob in which `*` crosses directory separators. A leading `/` is ignored.

`protected` MUST cover:

- the factory config and the CI configuration;
- every script the required checks execute through, such as a `Makefile` or `package.json` that defines the test command;
- every instruction file.

Test files MUST be covered by `protected` or `append_only`. The required checks MUST run the repository's full test suite.

Why 20 and 50: with zero failures in *n* trials, the true failure rate is plausibly as high as about 3/*n*. Twenty clean changes bound it near 15%, acceptable for documentation; fifty bound it near 6%.

## 4. Tier classification

The Gate MUST compute the tier with this procedure and no other input. It is deterministic and uses no model.

1. List every file the change adds, modifies, deletes or renames. A rename counts under both paths.
2. Assign each file a tier:
   - Tier 3 if it matches `protected`.
   - Tier 3 if it matches `append_only` and already exists on the base branch.
   - Otherwise the **highest** tier among `tiers.rules` whose paths match it.
   - Otherwise `tiers.default`.
3. The change's tier is the highest file tier.
4. While the change exceeds the `limits` of its tier, raise it by one. Tiers 2 and 3 have no limits.
5. If the change touches a path outside the work order's `scope.paths`, the decision is `escalate` regardless of tier.

"Highest wins" makes the result independent of rule order and means an added rule can only make classification stricter for the files it matches.

## 5. Evidence

| Kind | Produced by | Meaning |
|---|---|---|
| `checks` | Git host CI | Every check in `checks.required` succeeded on the head commit |
| `budget` | Gateway | Spend and time stayed within the run's ceilings |
| `test_integrity` | Gate, from CI test reports | The head commit executed at least as many tests as the base, and no test that ran on the base is skipped on the head |
| `new_test` | Gate, from the diff | The change adds at least one file under an `append_only` path |
| `holdout` | Git host CI | Every check in `checks.holdout` succeeded |
| `review` | Reviewer | Verdict `approve`, from a fresh context and a different model family than the Runner's |
| `behavior` | A check | An integration or browser run exercised the change |

Bars, which a config may raise but never lower:

| Tier | Required evidence | Decision when met |
|---|---|---|
| 0 | `checks`, `budget` | merge, if standing allows |
| 1 | Tier 0 plus `test_integrity`, `new_test`, `review`, and `holdout` when any are configured | merge, if standing allows |
| 2 | Tier 1 plus `behavior` | escalate with evidence summary |
| 3 | Tier 2 | escalate, always |

- The Gate MUST obtain every kind of evidence from its source itself. Statements in the change description or in Worker output are not evidence.
- `review` is supporting evidence. Research shows model reviewers miss most planted defects and that different models share blind spots, so no tier may rest on `review` alone.
- A repository SHOULD configure at least one holdout check before seeking Tier 1 standing.
- A failed required check MAY be rerun once. A pass after a failure counts, and MUST be recorded in the receipt's `unverified` list as a flaky check.

## 6. Work order and run

```yaml
apiVersion: oafactory/v1alpha1
kind: WorkOrder
id: "0042"
source: { host: github, issue: 412 }
requested_by: krishna
intent: Fix the crash when the config file is empty.
scope: { paths: [src/, tests/] }
budget: { usd_per_run: 1.00 }
```

- A work order MUST come from a person authorized for the repository. When it is derived from an issue, authorization MUST be an action only maintainers can take, such as applying a label.
- Issue text, code comments and review comments are untrusted input. They MUST NOT be able to change scope, budget or tier.

Run states:

```
queued -> running -> gated -> merged    -> watching -> held
                           -> escalated             -> reverted
                  -> abandoned
```

- A run that exceeds its budget MUST stop and end `abandoned`.
- A failed check or a `request_changes` review MAY start another attempt, up to `max_attempts`. Each attempt is a run with its own receipt.
- Every run, including an abandoned one, MUST produce a receipt.

## 7. Gate decisions and standing

Procedure for each change:

1. Load config from the base branch. If it is missing or invalid: `escalate`.
2. Classify (section 4).
3. Collect evidence (section 5) for the current head commit.
4. If the bar is not met: `escalate`, naming the missing evidence.
5. If the tier is 2 or 3: `escalate` with the evidence summary.
6. If `autonomy.mode` is `shadow`, or the repository lacks standing at this tier: record `would_merge` and `escalate`.
7. With probability `audit_rate`: record `would_merge`, mark the run `audit`, and `escalate`.
8. Otherwise merge, pinned to the head commit evaluated in step 3. If the head has moved, start again.

The Gate MUST write the receipt before merging. No receipt, no merge. The audit draw in step 7 MUST NOT be predictable by the Worker.

Standing is held per repository and per tier:

- **Agreement.** For a `would_merge` decision, a person merging the change with no further commits *agrees*; requesting changes or closing it *disagrees*. Agreement rate is agreeing decisions divided by all `would_merge` decisions a person has resolved. Escalations a person would have merged do not count against it.
- **Shadow.** The Gate records decisions; people merge everything.
- **Promotion.** A tier gains standing when its last `after_held` `would_merge` changes all ended `held`, agreement over them is at least `min_agreement`, and reverts are at most `max_reverts`. Promotion to Tier 1 requires standing at Tier 0. A person MUST confirm each promotion.
- **Audit.** While a tier has standing, audited changes keep the agreement rate current. If agreement over the last `after_held` audited changes falls below `min_agreement`, the tier loses standing.
- **Demotion.** One revert of a factory-merged change removes standing at that tier and every tier above it. Standing returns only through promotion.

## 8. Receipt

One per run, immutable once written. A receipt is the predicate of an in-toto statement whose subject is the head commit.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "git+https://github.com/owner/name", "digest": { "gitCommit": "<head sha>" } }],
  "predicateType": "https://oafactory.org/receipt/v1alpha1",
  "predicate": {
    "id": "0042-1",
    "work_order": "0042",
    "change": { "host": "github", "repo": "owner/name", "number": 431, "base": "<sha>" },
    "run": { "runner": "mini-swe-agent", "runner_model": "<resolved model>",
             "reviewer": "pr-agent", "reviewer_model": "<resolved model>",
             "cost_usd": 0.84, "minutes": 11, "state": "merged", "audit": false },
    "tier": { "value": 1, "because": ["src/config.py matched src/**"] },
    "evidence": [
      { "kind": "checks", "met": true, "source": "github:check-runs", "detail": { "lint": "success", "test": "success" } },
      { "kind": "test_integrity", "met": true, "source": "github:test-report", "detail": { "base": 412, "head": 413, "newly_skipped": 0 } },
      { "kind": "review", "met": true, "source": "pr-agent" }
    ],
    "unverified": ["No integration test covers the empty-file path."],
    "decision": { "value": "merge", "mode": "earned", "reason": "Tier 1 bar met; standing held." }
  }
}
```

- `unverified` is REQUIRED and MAY be empty. It lists what the factory could not establish.
- `runner_model` and `reviewer_model` MUST record the resolved models, not the aliases.
- The receipt MUST be stored in the Ledger and SHOULD be posted on the change.
- **Signing.** In shadow mode a receipt MAY be unsigned. Before any automatic merge, the Gate MUST sign the statement in a DSSE envelope using Sigstore. Signing MUST NOT depend on a paid Git host plan.
- The predicate type URI assumes the `oafactory.org` domain, which is not yet registered.
- The exact in-toto field names above are from memory of the v1 statement format and MUST be checked against the current specification before implementation.

## 9. Host interface

| Verb | GitHub | GitLab |
|---|---|---|
| Read a work order | `gh issue view` | `glab issue view` |
| Open a change | `gh pr create` | `glab mr create` |
| Read the diff | `gh pr diff` | `glab mr diff` |
| Read check status | `gh pr checks` | `glab ci status` |
| Rerun a check | `gh run rerun` | `glab ci retry` |
| Post a comment | `gh pr comment` | `glab mr note` |
| Merge at a pinned commit | `gh pr merge` | `glab mr merge` |
| Open a revert | revert commit, then open a change | same |

Exact subcommands and flags, including how each CLI pins a merge to a commit, are unconfirmed and MUST be verified against current releases before implementation.

Branch protection and code-owner rules on protected paths MUST remain enabled. The Git host is the last line of defence against a factory defect.

## 10. Ledger

Append-only. Three record kinds:

| Record | Written by | When |
|---|---|---|
| Receipt | Gate | End of every run |
| Outcome | Watcher | End of the watch window, or on revert |
| Standing | Gate | On promotion or demotion |

- The Ledger MUST live outside the repository and outside the Worker's reach.
- The Ledger MUST export every record as JSON Lines.
- Reference storage is SQLite, which needs no server. Postgres is the second backend, for a ledger shared across runners or repositories. Both sit behind one interface.

Scoreboard definitions:

| Metric | Definition |
|---|---|
| First-attempt accept rate | Runs merged on attempt 1 with no human commits, divided by work orders started |
| Cost per accepted change | Cost of all runs, including abandoned ones, divided by changes that ended `held` |
| Escalations per accepted change | Escalated runs divided by changes that ended `held` |
| Agreement rate by tier | As defined in section 7, over shadow and audited changes |
| Revert rate by tier | Changes `reverted` divided by changes merged, per tier |

Human minutes per accepted change is the metric that matters most and is not yet measurable; escalations stand in for it.

## 11. Watcher

For each factory-merged change, for `watch.window_hours`:

- If a required check fails on the default branch at the merge commit, the Watcher MUST rerun it once. If it fails again, the Watcher MUST open a revert. If it passes, the Watcher records a flaky check and takes no further action.
- The Gate MAY merge a revert automatically only after confirming it is the exact inverse of a factory-merged commit.
- A revert by a person that references the merge commit counts the same as a factory revert.
- The Watcher writes an Outcome of `held` or `reverted`. A `reverted` outcome triggers demotion (section 7).

Attributing a later failure to an earlier merge is unsolved and out of scope; only failures at the merge commit trigger an automatic revert.

## 12. Conformance

Levels are cumulative.

| ID | Level | The factory passes when |
|---|---|---|
| C1.1 | 1 Contained | A Worker request to a host outside the egress allowlist is refused |
| C1.2 | 1 | No Git host credential can be found in the Sandbox, including in git configuration |
| C1.3 | 1 | The Worker cannot read provider keys or the Gate credential |
| C1.4 | 1 | An instruction file added by the change is not loaded by the Runner or the Reviewer |
| C2.1 | 2 Governed | A run that reaches its budget stops and ends `abandoned` with a receipt |
| C2.2 | 2 | A change touching a protected path is classified Tier 3 |
| C2.3 | 2 | A change that edits the factory config is judged by the base-branch config |
| C2.4 | 2 | A change outside the work order's scope is escalated |
| C2.5 | 2 | A commit pushed after evidence was collected prevents the merge |
| C2.6 | 2 | In shadow mode the factory never merges |
| C2.7 | 2 | Modifying an existing file under an append-only path is classified Tier 3 |
| C2.8 | 2 | A change that causes fewer tests to run, or newly skips a test, yields no `test_integrity` evidence |
| C3.1 | 3 Accountable | A Reviewer in the Runner's model family yields no `review` evidence |
| C3.2 | 3 | No merge occurs without a stored receipt |
| C3.3 | 3 | A revert removes standing at that tier and above |
| C3.4 | 3 | A false "checks passed" claim in the change description does not count as evidence |
| C3.5 | 3 | Every run, including abandoned ones, has a receipt with an `unverified` field |
| C3.6 | 3 | Over many would-merge changes in earned mode, the audited share matches `audit_rate` |
| C3.7 | 3 | A single failure at the merge commit that passes on rerun does not cause a revert |
| C3.8 | 3 | An automatically merged change has a receipt whose signature verifies |

## 13. Known weaknesses and open questions

- **Passing checks is not correctness.** Published studies find roughly half of test-passing agent patches would be rejected by maintainers. This is why Tiers 0 and 1 are narrow and why agreement must be earned.
- **Model review is weak evidence.** See section 5.
- **Check indirection.** If CI runs `make test` and the Worker can edit the `Makefile`, it can hollow out the checks. The spec requires such files to be protected, but nothing detects a missing one automatically.
- **Append-only is not airtight.** In frameworks that auto-load files, a new file can alter existing tests (a pytest `conftest.py`, for example). `test_integrity` narrows this but does not close it.
- **Design quality is unmeasured.** No check captures maintainability. Audit sampling keeps people reading the code but does not score design.
- **Prompt injection** is mitigated by the trust boundaries, not eliminated.
- **Unproven at scale.** No organization has published outcome data for merging without human review.
- **Undecided:** how to measure human minutes; how `test_integrity` is obtained from CI systems that publish no test report; whether holdout checks should become mandatory for Tier 1.
- **Not covered:** changes spanning several repositories, monorepo ownership, deployment and production signals, self-generated work orders.

## 14. Build order

1. `oafactory ready` (done; needs `append_only`, `checks.required` and instruction-file checks)
2. Full config schema and the tier classifier (pure functions, section 4)
3. Receipt model and SQLite Ledger
4. Host adapters for `gh` and `glab`
5. Gate decision procedure in shadow mode, including agreement tracking
6. Harness, Runner, Sandbox, Gateway and Reviewer glue
7. Receipt signing, audit sampling, Watcher and automatic revert
8. Conformance suite
