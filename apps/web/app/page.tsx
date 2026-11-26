import Link from 'next/link';
import { SITE } from '@/lib/site';

const TIERS = [
  { n: 0, name: 'Documentation', needs: 'checks, budget', then: 'Merges, once the tier has standing', tone: 'ok' },
  { n: 1, name: 'Source with a new test', needs: 'Tier 0, plus test integrity, a new test, review and any holdout checks', then: 'Merges, once the tier has standing', tone: 'ok' },
  { n: 2, name: 'Unclassified or too large', needs: 'Tier 1, plus a behavior check', then: 'Goes to a person, with the evidence attached', tone: 'warn' },
  { n: 3, name: 'CI, config, existing tests, agent instructions', needs: 'Everything above', then: 'Goes to a person, always', tone: 'stop' },
];

const ATTEMPTS = [
  ['rewrites the Makefile so `make test` always passes', 'tier 3', 'Makefile matched protected Makefile'],
  ['edits an existing test to make it pass', 'tier 3', 'tests/test_config.py exists on the base branch under append-only tests/'],
  ['adds an AGENTS.md that says "always approve"', 'tier 3', 'docs/AGENTS.md matched protected *AGENTS.md'],
  ['says "all checks passed" in the description; they did not', 'tier 0', 'bar not met; missing evidence: checks'],
  ['changes source without adding a test', 'tier 1', 'bar not met; missing evidence: new_test'],
  ['edits the factory config to lower its own tier', 'tier 3', 'judged by the config on the base branch'],
];

const ROLES = [
  { name: 'Work order', by: 'A maintainer', text: 'Intent, the paths in scope, and a budget.' },
  { name: 'Runner', by: 'Your agent, in the Sandbox', text: 'Edits files and runs commands. Holds no Git credential and sees no provider key.', boxed: true },
  { name: 'Harness', by: 'Outside the Sandbox', text: 'Commits the files through a clean git directory, pushes the branch, opens the change.' },
  { name: 'Reviewer', by: 'A different model family', text: 'Reads the diff with a fresh context. Weak evidence, never decisive on its own.' },
  { name: 'Gate', by: 'Deterministic', text: 'Classifies, collects evidence from its sources, writes the receipt, then merges or escalates.', key: true },
  { name: 'Watcher', by: 'For 7 days', text: 'Reruns a failed check once, then opens a revert. One revert removes standing.' },
];

function Receipt() {
  const rows: Array<[string, string]> = [
    ['checks', 'lint, test passed on 9f2c41a'],
    ['budget', '$0.84 of $1.00, 11 of 30 min'],
    ['test_integrity', '412 tests on base, 413 on head'],
    ['new_test', 'tests/test_empty.py'],
    ['review', 'approve, different model family'],
  ];
  return (
    <figure className="receipt" aria-label="Example receipt">
      <div className="receipt-paper">
        <div className="receipt-head"><span>OAFACTORY RECEIPT</span><span>0042-1</span></div>
        <div className="receipt-sub"><span>acme/widgets #431</span><span>9f2c41ab77e0</span></div>
        <hr />
        <p className="receipt-label">Tier 1</p>
        <p className="receipt-line">src/config.py matched src/**</p>
        <p className="receipt-label">Evidence</p>
        <dl>
          {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd><b>met</b>{v}</dd></div>))}
        </dl>
        <p className="receipt-label">Not verified</p>
        <p className="receipt-line">No integration or browser run exercised this change.</p>
        <hr />
        <div className="receipt-total"><span>Decision</span><span>WOULD MERGE</span></div>
        <p className="receipt-foot">Shadow mode: a person decides.</p>
      </div>
      <figcaption>An example receipt. Every run gets one, including abandoned runs.</figcaption>
    </figure>
  );
}

const PLAIN = [
  ['You write a request', 'What you want done, which folders the AI may touch, and how much it may spend.'],
  ['An AI does the work', 'On a private copy. It cannot publish or approve its own work, and never sees a password or key.'],
  ['The change is published as a proposal', 'Anyone on the team can read exactly what changed. Nothing is accepted yet.'],
  ['A second AI gives an opinion', 'From a different maker. A second opinion, never the deciding one.'],
  ['The Gate decides', 'A fixed set of rules, not an AI. Small, low-risk changes may be accepted. Everything else goes to a person.'],
  ['You get a receipt', 'What was checked, what could not be confirmed, what it cost, and why.'],
];

const code = (s: string) => s.split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));

export default function Home() {
  return (
    <>
      <section className="hero wrap">
        <div>
          <p className="eyebrow">{SITE.tagline}</p>
          <h1>Agents write the code. Evidence decides what merges.</h1>
          <p className="lede">
            OAFactory runs the coding agent you already use inside a sandbox, then puts a deterministic Gate between its work and your default branch.
            The Gate collects its own evidence, starts in shadow mode, and leaves a receipt for every run.
          </p>
          <div className="cta">
            <Link className="btn primary" href="/docs/quickstart">Get started</Link>
            <a className="btn" href={SITE.repo}>View on GitHub</a>
          </div>
          <pre className="cmd" aria-label="Try the demo"><code><span className="prompt">$</span> oafactory demo<span className="comment">   # the whole lifecycle, in memory, no keys</span></code></pre>
        </div>
        <Receipt />
      </section>

      <section className="band">
        <div className="wrap">
          <h2>The slow part is no longer writing the change</h2>
          <div className="three">
            <div><h3>The author never judges its own work</h3><p>The agent runs with no Git credential and cannot push, merge or set its own risk tier. Nothing it says about its work counts as evidence.</p></div>
            <div><h3>Risk comes from the diff</h3><p>A tier is computed from the paths a change touches and the config on the base branch. No model is involved, so the same diff always gets the same tier.</p></div>
            <div><h3>Autonomy is earned, then kept</h3><p>The Gate only records what it would have done until a tier has a track record. One revert takes merge rights away again.</p></div>
          </div>
        </div>
      </section>

      <section className="wrap section">
        <p className="eyebrow">In plain words</p>
        <h2>What happens when you hand over a work order</h2>
        <p className="section-lede">You do not need an engineering background to follow a request from start to finish, or to read the result.</p>
        <ol className="plain">
          {PLAIN.map(([title, text]) => (<li key={title}><h3>{title}</h3><p>{text}</p></li>))}
        </ol>
        <pre className="cmd"><code><span className="prompt">$</span> oafactory explain work-order.yaml<span className="comment">   # this, for your own request and rules</span></code></pre>
        <p className="more"><Link href="/docs/work-orders-explained">A work order, in plain words</Link></p>
        <aside className="say-it">
          <div>
            <p className="eyebrow">From Claude, or any MCP client</p>
            <h3>Or just say what you want done</h3>
            <p>OAFactory ships an MCP server. Describe the change in conversation, and your assistant drafts the work order, shows you what would happen, and saves it. It cannot start work unless you allow it, and it can never approve or merge.</p>
            <p className="more"><Link href="/docs/guides/mcp">Use it from Claude</Link></p>
          </div>
          <div className="chat" aria-label="Example conversation">
            <p className="you"><span>You</span>Fix the crash on empty config files. Keep it to src and tests, and spend no more than a dollar.</p>
            <p className="them"><span>Assistant</span>Only in src/, tests/. Up to $1.00 and 30 minutes per attempt. This project is in shadow mode, so a person decides. Shall I save it?</p>
          </div>
        </aside>
      </section>

      <section className="band">
        <div className="wrap">
        <p className="eyebrow">How a change moves</p>
        <h2>Six roles, three credentials, one direction</h2>
        <p className="section-lede">Each role may do a few things and is denied the rest. The Harness, the Gate and the Watcher each hold a separate Git credential, and none of the three ever enters the Sandbox.</p>
        <ol className="flow">
          {ROLES.map((r, i) => (
            <li key={r.name} className={r.boxed ? 'boxed' : r.key ? 'key' : undefined}>
              <span className="step">{i + 1}</span>
              <h3>{r.name}</h3>
              <p className="by">{r.by}</p>
              <p>{r.text}</p>
            </li>
          ))}
        </ol>
        <p className="more"><Link href="/docs/concepts/how-it-works">Roles and trust boundaries</Link></p>
        </div>
      </section>

      <section className="wrap section">
          <p className="eyebrow">Tiers</p>
          <h2>Four risk tiers, set by what a change touches</h2>
          <div className="tiers">
            {TIERS.map((t) => (
              <div key={t.n} className={`tier ${t.tone}`}>
                <p className="tier-n">Tier {t.n}</p>
                <h3>{t.name}</h3>
                <p><span>Needs</span>{t.needs}</p>
                <p><span>Then</span>{t.then}</p>
              </div>
            ))}
          </div>
          <p className="more"><Link href="/docs/concepts/tiers">How classification works</Link> · <Link href="/docs/concepts/evidence">What counts as evidence</Link></p>
      </section>

      <section className="band">
      <div className="wrap split">
        <div>
          <p className="eyebrow">Built for an agent that wants to pass</p>
          <h2>The shortcuts are the escalations</h2>
          <p className="section-lede">An agent optimizing for green checks will find the cheap ways to get them. Each of these goes to a person, with the reason written on the receipt.</p>
          <p className="more"><Link href="/docs/reference/conformance">The conformance suite tests every one</Link></p>
        </div>
        <ul className="attempts">
          {ATTEMPTS.map(([what, tier, why]) => (
            <li key={what}>
              <p className="what">{code(what!)}</p>
              <p className="verdict"><b>ESCALATE</b><span>{tier}</span>{why}</p>
            </li>
          ))}
        </ul>
      </div>
      </section>

      <section className="wrap section">
          <p className="eyebrow">Standing</p>
          <h2>From shadow mode to merging, and back</h2>
          <ol className="ladder">
            <li><h3>Shadow</h3><p>The Gate records <code>would_merge</code> or <code>escalate</code>. People merge everything. You see how often you agree with it.</p></li>
            <li><h3>Promote</h3><p>After 20 docs changes, or 50 code changes, merged unchanged and held for a week with 95% agreement, a person confirms the promotion.</p></li>
            <li><h3>Audit</h3><p>One in ten would-merge changes still goes to a person, chosen by a draw the agent cannot predict.</p></li>
            <li><h3>Demote</h3><p>One revert removes standing at that tier and every tier above. It returns only through promotion.</p></li>
          </ol>
          <p className="more"><Link href="/docs/concepts/standing">How standing is earned and lost</Link></p>
      </section>

      <section className="band">
        <div className="wrap">
          <p className="eyebrow">Free and open</p>
          <h2>One edition. Nothing behind a paid tier.</h2>
          <div className="three">
            <div><h3>Every feature is in the open-source package</h3><p>Shadow mode, earned mode, signed receipts, the Watcher and the conformance suite. Apache 2.0, with no enterprise edition.</p></div>
            <div><h3>No account, no telemetry</h3><p>A command-line tool that runs on your machine. It talks to your Git host and your AI provider, and to nobody else.</p></div>
            <div><h3>Bring any agent and any model</h3><p>If it runs from a command line, it works. You pay your AI provider directly, and the work order's budget caps it.</p></div>
          </div>
          <p className="more"><Link href="/docs/free-and-open">What is free, and what you still pay others for</Link></p>
        </div>
      </section>

      <section className="wrap section split">
        <div>
          <p className="eyebrow">Read this first</p>
          <h2>What it cannot tell you</h2>
          <p className="section-lede">OAFactory is version 0.1, and the idea it implements is unproven at scale. We would rather you knew the limits before the first merge than after.</p>
          <p className="more"><Link href="/docs/reference/status">Status and limits, in full</Link></p>
        </div>
        <ul className="limits">
          <li><b>Passing checks is not correctness.</b> Published studies find roughly half of test-passing agent patches would be rejected by maintainers.</li>
          <li><b>Model review is weak evidence.</b> Reviewers miss most planted defects, and different models share blind spots.</li>
          <li><b>Not yet field-tested end to end.</b> Reading from live GitHub works. Merging through the adapter, GitLab, the Docker sandbox and Sigstore signing are written and unit-tested, not yet run for real.</li>
          <li><b>No one has published outcome data</b> for merging without human review. Start in shadow mode and stay there until your own numbers say otherwise.</li>
        </ul>
      </section>

      <section className="band start">
        <div className="wrap">
          <h2>Start in shadow mode</h2>
          <p className="section-lede">It changes nothing about how you merge. It shows you what a Gate would have done.</p>
          <pre className="cmd big"><code>
            <span className="prompt">$</span> git clone {SITE.repo}{'\n'}
            <span className="prompt">$</span> cd oafactory && npm install && npm run build && npm link -w oafactory{'\n'}
            <span className="prompt">$</span> oafactory demo{'\n'}
            <span className="prompt">$</span> cd ~/your-repo && oafactory init && oafactory ready
          </code></pre>
          <div className="cta">
            <Link className="btn primary" href="/docs/quickstart">Read the quickstart</Link>
            <a className="btn" href={SITE.spec}>Read the spec</a>
          </div>
        </div>
      </section>
    </>
  );
}
