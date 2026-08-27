import { SiteNav } from './components/SiteNav';
import { SiteFooter } from './components/SiteFooter';
import { ClimbLoop } from './components/ClimbLoop';
import { Artifact } from './components/Artifact';
import { Reveal } from './components/Reveal';

export default function Home() {
  return (
    <>
      <SiteNav />
      <main id="top">
        <header className="hero">
          <div className="wrap hero-in">
            <p className="hero-kicker">Independent review for work made by AI</p>
            <h1 className="hero-h1">
              <span className="lockup">
                <ClimbLoop />
                <span className="wordmark">Camus</span>
              </span>
              <span className="tagline">Trust the work, not the model that made it.</span>
            </h1>
            <p className="hero-sub">
              One AI does the work. Another, from a different company, checks it
              against what you said must be true. Tests and sources settle what they
              can. You make the calls they should not.
            </p>
            <div className="cta-row">
              <a className="cta" href="/studio/">Open Loop Studio</a>
              <a className="cta-ghost" href="#proof">See a real catch ↓</a>
            </div>
            <div className="hero-proof" aria-label="What Camus gives you">
              <b>public alpha 0.4.4</b>
              <b>deterministic local control</b>
              <b>an independent second opinion</b>
              <b>tests and sources attached</b>
              <b>receipts bound to the exact result</b>
            </div>
          </div>
        </header>

        <section className="sec sec--soft" id="why">
          <div className="wrap">
            <Reveal>
              <p className="section-label">The problem</p>
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
                <img className="sec-art" src="/brand/covers/the-glare.svg" alt="An original Camus cover study" width="400" height="600" />
              </div>
            </Reveal>

            <div className="value-grid">
              <Reveal className="value-card">
                <span className="card-num">01</span>
                <h3>The maker can miss its own mistake.</h3>
                <p>Stronger models make better work, but confidence is still not evidence.</p>
              </Reveal>
              <Reveal className="value-card">
                <span className="card-num">02</span>
                <h3>Self-review shares the blind spot.</h3>
                <p>The same model family tends to defend the choices and style it already produced.</p>
              </Reveal>
              <Reveal className="value-card">
                <span className="card-num">03</span>
                <h3>Review can detach from the final result.</h3>
                <p>A clean verdict is meaningless if the artifact changes after the reviewer saw it.</p>
              </Reveal>
            </div>

            <Reveal>
              <p className="thesis-line">
                Camus keeps the artifact, the evidence, the independent verdict, and
                the human decision bound together.
              </p>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="proof">
          <div className="wrap">
            <Reveal>
              <p className="section-label">A live example</p>
              <div className="sec-head sec-head--wide">
                <div>
                  <h2 className="sec-h2">The first model sounded right. The second model checked.</h2>
                  <p className="sec-sub">
                    In a real research run, Sonnet drafted a plausible strategy from
                    Hivemind material. GPT-5.4 found claims the source did not support,
                    including a raw search score rewritten as “Relevance: 76%” after
                    the contract explicitly forbade interpreting score semantics.
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
                <Artifact tone="dark" path="sealed evidence pack" label="A compact Camus evidence receipt">
{`standing       `}<span className="ok">verified</span>{`
execution      completed
verification   passed
audit          independent_clean
publication    not_published

executor       anthropic:sonnet
auditor        openai:gpt-5.4
artifact       59ee19193b8b
receipt        0b8960d2e40d`}
                </Artifact>
                <p className="receipt-note">
                  The full receipt also preserves the acceptance contract, exact model
                  identities, human decisions, checks, findings, and evidence bundle.
                </p>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec sec--ink" id="how">
          <div className="wrap">
            <Reveal>
              <p className="section-label">How Camus works</p>
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
                <h3>Challenge it independently</h3>
                <p>A different model audits the artifact. Tests and captured sources arbitrate where possible.</p>
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
              <p className="section-label">Human in the loop</p>
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
              <p className="section-label">Where Camus goes next</p>
              <div className="direction-head">
                <h2 className="sec-h2">Better models make Camus more useful, not less.</h2>
                <p className="sec-sub">
                  Frontier models are becoming excellent orchestrators. Camus will let
                  them own the workers while it compares what they produce under one
                  contract and keeps any model from awarding itself trusted standing.
                </p>
              </div>
            </Reveal>

            <div className="direction-grid">
              <Reveal className="direction-card direction-card--now">
                <p className="direction-tag">Available now</p>
                <h3>Hybrid control, independent trust</h3>
                <p>
                  Models plan, make, and review. The 0.4.4 driver keeps dispatch, budgets,
                  Git, verification, recovery, and sealed evidence out of model context.
                </p>
              </Reveal>
              <Reveal className="direction-card">
                <p className="direction-tag">Available in Studio</p>
                <h3>Controlled comparison</h3>
                <p>
                  Freeze one goal, contract, reviewer, and knowledge snapshot across
                  two or three executor arms. Keep every success and failure in the
                  parent receipt. Blinded winner selection remains the next slice.
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
              <p className="section-label">Two ways in</p>
              <h2 className="sec-h2">Built for work you stake your name on.</h2>
              <p className="sec-sub">
                The trust protocol is the same. The interface meets you where the work lives.
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
                  <li>qualified Claude, GPT, Grok, Kimi, Qwen, or local model seats</li>
                  <li>Hivemind grounding through your Claude MCP</li>
                  <li>verification-only recovery for parked code</li>
                </ul>
                <a className="cta" href="/studio/">Open Loop Studio</a>
              </Reveal>

              <Reveal className="audience-card audience-card--code">
                <p className="audience-kicker">For developers</p>
                <h3>Camus CLI</h3>
                <p>
                  Give an agent a real repository without giving up custody. Work stays
                  isolated, reviews bind to exact commits, tests have the final word,
                  and every change reaches your branch with its actual standing attached.
                </p>
                <ul>
                  <li>isolated worktrees and controlled merge</li>
                  <li>deterministic feature state and bounded budgets</li>
                  <li>cross-vendor code review</li>
                  <li>HEAD-bound verification</li>
                  <li>crash-safe resume and named human halts</li>
                </ul>
                <a className="cta-ghost audience-link" href="https://www.npmjs.com/package/camus-cli">View camus-cli on npm ↗</a>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec sec--soft" id="run">
          <div className="wrap">
            <Reveal>
              <p className="section-label">Run it locally</p>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Your machine keeps custody.</h2>
                  <p className="sec-sub">
                    Orchestration and receipts stay on your machine. Model and Hivemind
                    requests go to the services you already authenticate. Camus does
                    not bundle or proxy your subscriptions.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-descent.svg" alt="An original Camus cover study" width="400" height="600" />
              </div>
            </Reveal>

            <Reveal>
              <div className="term">
                <pre>
{`$ npm i -g camus-cli@0.4.7
$ camus install
$ camus check

$ camus start feature.json
`}<span className="g">✓</span>{` feature initialized without a model turn
$ camus run <featId>

`}<span className="g">✓</span>{` durable maker finished in an isolated worktree
`}<span className="r">✗</span>{` independent review found a missing guard
`}<span className="g">✓</span>{` repair passed 163 tests
`}<span className="g">✓</span>{` verified receipt bound to commit a1f9c2e`}
                </pre>
              </div>
            </Reveal>

            <Reveal>
              <div className="cta-row cta-row--left">
                <a className="cta" href="/studio/">Try the visual Studio</a>
                <a className="cta-ghost" href="https://github.com/mateodaza/camus">Read the source ↗</a>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec closing" id="philosophy">
          <div className="wrap closing-grid">
            <Reveal>
              <figure className="closing-mark">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/covers/the-climb.svg" alt="The Camus loop, held as a still" width="400" height="600" />
                <figcaption>Camus</figcaption>
              </figure>
            </Reveal>
            <Reveal className="closing-copy">
              <p className="section-label">The principle</p>
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
