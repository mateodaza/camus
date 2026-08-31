import { SiteNav } from './components/SiteNav';
import { SiteFooter } from './components/SiteFooter';
import { ClimbLoop } from './components/ClimbLoop';
import { Artifact } from './components/Artifact';
import { Reveal } from './components/Reveal';

export default function Home() {
  return (
    <>
      <SiteNav />
      <main id="top" tabIndex={-1}>
        <header className="hero">
          <div className="wrap hero-in">
            <h1 className="hero-h1">
              <span className="lockup">
                <ClimbLoop />
                <span className="wordmark">Camus</span>
              </span>
              <span className="tagline">Trust the work, not the model that made it.</span>
            </h1>
            <p className="hero-sub">
              Camus is the local control plane for AI work you need to verify.
              Choose one model or coding agent to make it and another to challenge
              it against your contract. Camus runs the checks you configure, keeps
              control local, and binds the evidence to the exact result before you
              decide to ship.
            </p>
            <div className="cta-row">
              <a className="cta" href="#run">Install the CLI ↓</a>
              <a className="cta-ghost" href="#proof">See a documented run ↓</a>
            </div>
            <div className="hero-proof" aria-label="What Camus gives you">
              <b>open-source public alpha</b>
              <b>control stays local</b>
              <b>maker and reviewer chosen separately</b>
              <b>you decide what ships</b>
            </div>
          </div>
        </header>

        <section className="sec sec--soft" id="why">
          <div className="wrap">
            <Reveal>
              <div className="sec-head sec-head--wide">
                <div>
                  <h2 className="sec-h2">Models are multiplying. Accountability isn’t.</h2>
                  <p className="sec-sub">
                    Claude, GPT, Grok, Qwen, open weights, and native agent harnesses
                    improve on different curves. Switching models is easy. Proving what
                    ran, under which budget, against which exact artifact, is not.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-glare.svg" alt="" width="400" height="600" />
              </div>
            </Reveal>

            <div className="value-grid">
              <Reveal className="value-card">
                <h3>Better models still miss their own mistakes.</h3>
                <p>Capability improves the work. It does not turn confidence into evidence.</p>
              </Reveal>
              <Reveal className="value-card">
                <h3>A harness changes more than the model.</h3>
                <p>Context, tools, retries, and side calls can change the result and its cost.</p>
              </Reveal>
              <Reveal className="value-card">
                <h3>Review can detach from the final artifact.</h3>
                <p>A clean verdict means little if the work changes after the reviewer saw it.</p>
              </Reveal>
            </div>

            <Reveal>
              <p className="thesis-line">
                Change the models without changing what “trusted” means.
              </p>
              <p className="thesis-support">
                Camus keeps the contract, artifact, identities, evidence, verdict,
                and human decision bound together while the model layer changes.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="proof">
          <div className="wrap">
            <Reveal>
              <div className="sec-head sec-head--wide">
                <div>
                  <h2 className="sec-h2">Camus records the fix—and refuses to launder the failure around it.</h2>
                  <p className="sec-sub">
                    In one bounded dogfood run documented in the public model-setup
                    report, Qwen3.8 Max through Camus file actions made the exact fix,
                    the host verifier passed, and GPT-5.6 Luna approved it. The same
                    fixture through native Qwen Code retained the right-looking change
                    but never closed the harness session, so its sealed standing remained failed.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="proof-layout">
              <Reveal className="proof-story">
                <div className="proof-row">
                  <span>Made</span>
                  <p>Qwen3.8 Max made the canonical one-line fix in five responses and six actions.</p>
                </div>
                <div className="proof-row proof-row--verified">
                  <span>Verified</span>
                  <p>The frozen host check passed against the exact candidate.</p>
                </div>
                <div className="proof-row">
                  <span>Reviewed</span>
                  <p>A separately selected Luna reviewer approved with no findings.</p>
                </div>
                <div className="proof-row proof-row--refused">
                  <span>Refused</span>
                  <p>The native path kept a correct-looking edit but no definitive terminal, so Camus did not upgrade it.</p>
                </div>
              </Reveal>

              <Reveal className="proof-receipt">
                <p className="receipt-kicker">The useful result remained advisory.</p>
                <Artifact tone="dark" path="documented dogfood summary" label="A documented Camus dogfood summary">
{`task_class      simple_bounded_code
maker           qwen/qwen3.8-max
executor        file_actions
reviewer        codex:gpt-5.6-luna
verification    `}<span className="ok">passed</span>{`
review          approved_no_findings
human_accept    required
maker_time      83.8s
maker_tokens    7,445`}
                </Artifact>
                <p className="receipt-note">
                  The fixture and report are public; the underlying run receipt remains
                  private, so this is a documented case rather than independently
                  replayable evidence. It is not a model ranking. Inspect the{' '}
                  <a className="inline-link" href="https://github.com/mateodaza/camus/blob/main/apps/loop-studio/fixtures/code-eval-v1/simple-bounded-parser-fix/fixture.json">fixture ↗</a>
                  {' '}and the{' '}
                  <a className="inline-link" href="https://github.com/mateodaza/camus/blob/main/docs/RECOMMENDED-MODEL-SETUP.md">dogfood report ↗</a>.
                </p>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec sec--ink" id="how">
          <div className="wrap">
            <Reveal>
              <h2 className="sec-h2">Four parts. One honest result.</h2>
              <p className="sec-sub">
                Camus is not another agent. Models handle semantic work; a deterministic
                local kernel owns state, budgets, Git custody, recovery, and evidence.
                No model gets to award itself trusted standing.
              </p>
            </Reveal>

            <div className="flow-grid">
              <Reveal className="flow-step">
                <span>1</span>
                <h3>Set the contract</h3>
                <p>State the goal, what must be true, the permitted knowledge, and the budget.</p>
              </Reveal>
              <Reveal className="flow-step">
                <span>2</span>
                <h3>Let the maker work</h3>
                <p>A qualified model or native coding harness owns the semantic work. The local kernel handles the plumbing.</p>
              </Reveal>
              <Reveal className="flow-step">
                <span>3</span>
                <h3>Challenge it separately</h3>
                <p>The selected reviewer tries to break the artifact. Recorded identities determine whether that review is independent; configured tests and sources arbitrate what they can.</p>
              </Reveal>
              <Reveal className="flow-step">
                <span>4</span>
                <h3>Decide and seal</h3>
                <p>Ambiguity goes to you. Every verdict binds to the exact artifact it certified.</p>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec" id="human">
          <div className="wrap">
            <Reveal>
              <h2 className="sec-h2">You are not removed from the loop. You are removed from babysitting it.</h2>
            </Reveal>

            <div className="authority-grid">
              <Reveal className="authority-col">
                <h3>Camus handles the repetition</h3>
                <ul>
                  <li>draft, review, repair, and bounded retry</li>
                  <li>deterministic checks and source capture</li>
                  <li>model identity, artifact lineage, and receipts</li>
                  <li>stopping when another round is not justified</li>
                </ul>
              </Reveal>
              <Reveal className="authority-col authority-col--human">
                <h3>You keep authority</h3>
                <ul>
                  <li>define success and the allowed knowledge</li>
                  <li>resolve ambiguity and reviewer disagreement</li>
                  <li>approve high-cost or high-risk work</li>
                  <li>choose, publish, merge, or walk away</li>
                </ul>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec sec--direction" id="direction">
          <div className="wrap">
            <Reveal>
              <div className="direction-head">
                <h2 className="sec-h2">What is trusted today—and what remains evidence-gated.</h2>
                <p className="sec-sub">
                  Camus applies versioned contracts across supported paths. Each exact
                  path earns only the standing its checks, identity, and evidence support.
                </p>
              </div>
            </Reveal>

            <div className="direction-grid">
              <Reveal className="direction-card direction-card--now">
                <p className="direction-tag">Trusted path</p>
                <h3>Claude → Codex proof gate</h3>
                <p>
                  Fixed cross-vendor roles, isolated Git custody, HEAD-bound verification,
                  bounded recovery, and a review bound to the exact candidate.
                </p>
              </Reveal>
              <Reveal className="direction-card direction-card--experimental">
                <p className="direction-tag">Advisory path</p>
                <h3>Flexible Build</h3>
                <p>
                  Choose any qualified maker and reviewer pair, then use Camus file
                  actions or an eligible native Codex, Qwen Code, or Grok Build harness.
                  The candidate stays advisory and never lands without human acceptance.
                </p>
                <p>
                  The built-in Grok seat can use a pinned Grok Build subscription
                  path. Repeated simple-task maker evidence is verifier-green, but
                  the path remains unrouted and advisory until review evidence closes.
                </p>
              </Reveal>
              <Reveal className="direction-card direction-card--evidence">
                <p className="direction-tag">Evaluation infrastructure</p>
                <h3>Automatic routing stays off</h3>
                <p>
                  Matched evals and blinded human calibration can accumulate task-class
                  evidence. No model is promoted and no universal “best model” is claimed
                  until that evidence earns it.
                </p>
              </Reveal>
            </div>

            <Reveal>
              <p className="direction-law">
                The quality floor comes first. Only then does Camus optimize tokens,
                time, and cost. Cheap failure never wins.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="studio">
          <div className="wrap">
            <Reveal>
              <h2 className="sec-h2">One control plane. Two ways to work.</h2>
              <p className="sec-sub">
                Camus starts with code, where trusted tests can arbitrate; the same
                control plane extends to evidence-heavy research and writing. Use the
                CLI for repositories or the browser for documents and investigations.
              </p>
            </Reveal>

            <div className="audience-grid">
              <Reveal className="audience-card audience-card--code">
                <p className="audience-kicker">For developers</p>
                <h3>Camus CLI</h3>
                <p>
                  Give an agent a real repository without giving up custody. Work stays
                  isolated, reviews bind to exact candidates, and tests arbitrate what
                  they can. Flexible Build remains advisory until you accept it.
                </p>
                <ul>
                  <li>isolated worktrees and controlled merge</li>
                  <li>deterministic feature state and bounded budgets</li>
                  <li>maker and reviewer selectable independently</li>
                  <li>HEAD-bound verification</li>
                  <li>provider-free receipt inspection</li>
                </ul>
                <a className="cta-ghost audience-link" href="https://www.npmjs.com/package/camus-cli">View camus-cli on npm ↗</a>
              </Reveal>

              <Reveal className="audience-card">
                <p className="audience-kicker">For research and marketing</p>
                <h3>Loop Studio</h3>
                <p>
                  Write a memo, investigate competitors, or turn Hivemind knowledge
                  into a grounded deliverable. Use plain language, inspect every
                  objection, and step in only for real judgment calls.
                </p>
                <ul>
                  <li>browser interface, no JSON noise</li>
                  <li>the full acceptance contract in your own words</li>
                  <li>connections for Claude, GPT, Grok, Qwen, and OpenAI-compatible or local seats</li>
                  <li>built-in Claude/Codex seats use versioned qualification contracts; configurable seats require exact local qualification</li>
                  <li>native harness artifacts separately prove readiness and policy compatibility</li>
                  <li>Hivemind grounding through your Claude MCP</li>
                  <li>explicit publication consent and sealed receipts</li>
                </ul>
                <a className="cta" href="/studio/">Open Loop Studio</a>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec sec--soft" id="run">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">The control plane stays on your machine.</h2>
                  <p className="sec-sub">
                    Orchestration, budgets, run state, and receipts stay local. Configurable
                    API credentials are held by the local service and sent only to the
                    selected provider endpoint; they are never sent to camus.sh or exposed
                    to native workers. Providers still receive the context you choose to
                    send. Native Qwen and configured API-backed Grok workers can reach
                    only the selected model through a host-owned one-model gateway. The
                    built-in Grok subscription seat keeps Grok Build's own login and
                    inference route, strips API keys, pins the reviewed artifact, and
                    applies Camus's bounded tool policy.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-descent.svg" alt="" width="400" height="600" />
              </div>
            </Reveal>

            <Reveal>
              <div className="term">
                <pre>
{`$ npm i -g camus-cli@latest
$ camus models
$ camus build --maker <backend>:<model> \\
    --reviewer <backend>:<model> --task "..." --contract "..." \\
    --verify "pnpm test"

`}<span className="g">✓</span>{` selected seats authorized for launch (built-in or qualified)
`}<span className="g">✓</span>{` candidate isolated from your branch
`}<span className="g">✓</span>{` trusted verifier passed
`}<span className="r">!</span>{` clean advisory review; human acceptance still required

$ camus build --inspect <runId>
`}<span className="g">✓</span>{` receipt inspected without a provider call`}
                </pre>
              </div>
            </Reveal>

            <Reveal>
              <div className="cta-row cta-row--left">
                <a className="cta" href="https://github.com/mateodaza/camus/blob/main/QUICKSTART.md">Install from the quick start ↗</a>
                <a className="cta-ghost" href="/studio/">Try the visual Studio</a>
                <a className="cta-ghost" href="https://github.com/mateodaza/camus">Read the source ↗</a>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec sec--pilot" id="pilot">
          <div className="wrap pilot-grid">
            <Reveal>
              <h2 className="sec-h2">Bring one real task. Leave with a receipt—or an honest refusal.</h2>
              <p className="sec-sub">
                Camus is in public alpha. Run it yourself, or bring one bounded code,
                research, or launch-critical content workflow to a design-partner session.
                We will record what worked, what stopped safely, and where human judgment
                was actually needed.
              </p>
            </Reveal>
            <Reveal className="pilot-actions">
              <a className="cta" href="https://github.com/mateodaza/camus/issues/new?template=design-partner.yml">Propose a pilot ↗</a>
              <a className="cta-ghost" href="/studio/">Open Loop Studio</a>
              <a className="cta-ghost" href="https://www.npmjs.com/package/camus-cli">Install Camus ↗</a>
              <p className="pilot-note">Do not post credentials, private source, raw diagnostics, or unreviewed receipts.</p>
            </Reveal>
          </div>
        </section>

        <section className="sec closing" id="philosophy">
          <div className="wrap closing-grid">
            <Reveal>
              <figure className="closing-mark">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/covers/the-climb.svg" alt="" width="400" height="600" />
                <figcaption>Camus</figcaption>
              </figure>
            </Reveal>
            <Reveal className="closing-copy">
              <h2 className="sec-h2">No intelligence should be the only judge of its own work.</h2>
              <p className="sec-sub">
                Models will change. The need for independent judgment, inspectable
                evidence, and a meaningful human decision will not.
              </p>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
