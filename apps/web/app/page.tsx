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
              One model does the work. A separate reviewer challenges it against
              what you said must be true. Cross-vendor review, tests, and captured
              sources strengthen the result when configured. The receipt records
              what actually happened.
            </p>
            <div className="cta-row">
              <a className="cta" href="/studio/">Open Loop Studio</a>
              <a className="cta-ghost" href="#proof">See a sanitized catch ↓</a>
            </div>
            <div className="hero-proof" aria-label="What Camus gives you">
              <b>public alpha</b>
              <b>local control plane</b>
              <b>maker and reviewer chosen separately</b>
              <b>checks and sources recorded when used</b>
              <b>receipts bound to the exact result</b>
            </div>
          </div>
        </header>

        <section className="sec sec--soft" id="why">
          <div className="wrap">
            <Reveal>
              <div className="sec-head sec-head--wide">
                <div>
                  <h2 className="sec-h2">A confident answer is not the same as a trustworthy one.</h2>
                  <p className="sec-sub">
                    The model that made the work shares its own assumptions, omissions,
                    and incentives. Asking it to check itself can produce a more polished
                    version of the same blind spot.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-glare.svg" alt="" width="400" height="600" />
              </div>
            </Reveal>

            <div className="value-grid">
              <Reveal className="value-card">
                <h3>The maker can miss its own mistake.</h3>
                <p>Stronger models make better work, but confidence is still not evidence.</p>
              </Reveal>
              <Reveal className="value-card">
                <h3>Self-review shares the blind spot.</h3>
                <p>The same model family tends to defend the choices and style it already produced.</p>
              </Reveal>
              <Reveal className="value-card">
                <h3>Review can detach from the final result.</h3>
                <p>A clean verdict is meaningless if the artifact changes after the reviewer saw it.</p>
              </Reveal>
            </div>

            <Reveal>
              <p className="thesis-line">
                Camus keeps the artifact, the evidence, the recorded verdict, and
                the human decision bound together.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="proof">
          <div className="wrap">
            <Reveal>
              <div className="sec-head sec-head--wide">
                <div>
                  <h2 className="sec-h2">In one private run, the first model sounded right. The second model checked.</h2>
                  <p className="sec-sub">
                    This sanitized reconstruction preserves the finding while withholding
                    the private corpus and receipt. Sonnet drafted a plausible strategy;
                    GPT-5.4 found unsupported claims, including a raw search score rewritten
                    as “Relevance: 76%” after the contract forbade that interpretation.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="proof-layout">
              <Reveal className="proof-story">
                <div className="proof-row">
                  <span>Made</span>
                  <p>Sonnet produced the initial strategy using the frozen research context.</p>
                </div>
                <div className="proof-row proof-row--caught">
                  <span>Caught</span>
                  <p>GPT-5.4 blocked unsupported interpretations instead of rewarding persuasive prose.</p>
                </div>
                <div className="proof-row">
                  <span>Human</span>
                  <p>One decision reached the human: authorize one more repair round.</p>
                </div>
                <div className="proof-row proof-row--sealed">
                  <span>Sealed</span>
                  <p>The repaired result passed verification and earned an independent clean audit.</p>
                </div>
              </Reveal>

              <Reveal className="proof-receipt">
                <p className="receipt-kicker">The result did not merely say “done.”</p>
                <Artifact tone="dark" path="sanitized receipt view" label="A sanitized Camus evidence receipt">
{`standing       `}<span className="ok">verified</span>{`
execution      completed
verification   passed
audit          independent_clean
publication    not_published

executor       anthropic:sonnet
reviewer       openai:gpt-5.4
artifact       [private]
receipt        [private]`}
                </Artifact>
                <p className="receipt-note">
                  The original receipt preserves the acceptance contract, exact model
                  identities, human decisions, checks, findings, and evidence bundle.
                  Current public dogfood evidence is documented in the{' '}
                  <a className="inline-link" href="https://github.com/mateodaza/camus/blob/main/docs/RECOMMENDED-MODEL-SETUP.md">model setup report ↗</a>.
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
                Models handle semantic work. A deterministic local kernel owns state,
                budgets, Git custody, and evidence. No model gets to award itself trusted
                standing.
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
                <p>A durable model session owns the semantic work. The local kernel handles the plumbing.</p>
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
                <h2 className="sec-h2">What ships now—and what Camus refuses to pretend.</h2>
                <p className="sec-sub">
                  The control plane is stable across models. Standing still depends on
                  the exact path, checks, review identity, and evidence that actually ran.
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
                <p className="direction-tag">Experimental</p>
                <h3>Flexible Build</h3>
                <p>
                  Choose any qualified maker and reviewer pair, then use Camus file
                  actions or an eligible native Codex, Qwen Code, or Grok Build harness.
                  The candidate stays advisory and never lands without human acceptance.
                </p>
              </Reveal>
              <Reveal className="direction-card direction-card--evidence">
                <p className="direction-tag">Evidence-gated</p>
                <h3>A/B learning and routing</h3>
                <p>
                  Studio freezes two Claude writing arms and supports blinded human calibration.
                  Automatic routing stays off without sufficient calibrated evidence;
                  Camus makes no universal “best model” claim.
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
              <h2 className="sec-h2">Built for work you stake your name on.</h2>
              <p className="sec-sub">
                One control plane, with standing that stays honest about the path you chose.
              </p>
            </Reveal>

            <div className="audience-grid">
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
                  <li>capability-qualified Claude, GPT, Grok, Qwen, or local seats</li>
                  <li>Hivemind grounding through your Claude MCP</li>
                  <li>explicit publication consent and sealed receipts</li>
                </ul>
                <a className="cta" href="/studio/">Open Loop Studio</a>
              </Reveal>

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
            </div>
          </div>
        </section>

        <section className="sec sec--soft" id="run">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Your machine keeps custody.</h2>
                  <p className="sec-sub">
                    Orchestration and receipts stay on your machine. Built-in CLI seats
                    use your existing sessions; configurable API seats use credentials
                    held by the local service. Native Qwen and Grok workers can reach only
                    the selected model through a host-owned one-model gateway.
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

`}<span className="g">✓</span>{` exact seats qualified on this machine
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
                <a className="cta" href="/studio/">Try the visual Studio</a>
                <a className="cta-ghost" href="https://github.com/mateodaza/camus">Read the source ↗</a>
                <a className="cta-ghost" href="https://github.com/mateodaza/camus/issues/new?title=Design%20partner%20pilot">Join the design-partner pilot ↗</a>
              </div>
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
