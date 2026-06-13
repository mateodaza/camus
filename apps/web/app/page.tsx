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
            <h1 className="hero-h1">
              <span className="lockup">
                <ClimbLoop />
                <span className="wordmark">Camus</span>
              </span>
              <span className="tagline">Makes it work. Knows when to stop.</span>
            </h1>
            <p className="hero-sub">
              A competing model reviews every change, your own tests have the final word, and
              every green names the exact commit it certified. When the loop stops being
              trustworthy, it stops — evidence preserved, a decision on your desk.
              No agent grades its own work.
            </p>
            <div className="cta-row">
              <a className="cta" href="https://www.npmjs.com/package/camus-cli">npx camus-cli install</a>
              <a className="cta-ghost" href="https://github.com/mateodaza/camus">GitHub &#8599;</a>
            </div>
            <div className="hero-proof">
              <b>cross-model review</b>
              <b>isolated worktrees</b>
              <b>head-bound verify</b>
              <b>crash-safe resume</b>
              <b>named human halts</b>
              <b>run history + canary</b>
            </div>
          </div>
        </header>

        <section className="sec" id="watch">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Watch it work.</h2>
                  <p className="sec-sub">
                    It ships as a skill and two workflows, so it runs wherever skills run. Every phase
                    of every task is on screen as it happens.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-glare.svg" alt="A cover study after The Stranger" width="400" height="600" />
              </div>
            </Reveal>
            <Reveal>
              <div className="term term--tree">
                <pre>
{`camus · feat "harden input boundaries" · 3 tasks

  `}<span className="g">✓</span>{`  env + baseline
  │
  `}<span className="g">✓</span>{`  1  guard empty input · embedding.ts        sonnet
  │     plan · implement · review · verify          → a1f9c2e
  │
  `}<span className="g">✓</span>{`  2  filter empty roles · chunk-roles.ts     sonnet → opus
  │     plan · implement · `}<span className="r">review ⇄ fix ×2</span>{` · verify  → 3c4d5e6
  │
  `}<span className="r">▍</span>{`  3  guard the question counter · counter.ts  sonnet
  │     plan · implement · `}<span className="r">reviewing …</span>{`
  │
  …  integration verify · report → ~/.camus/reports/harden-…json`}
                </pre>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="honest">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Every change clears an outside reviewer.</h2>
                  <p className="sec-sub">
                    Real accountability comes from outside. Claude could run the whole loop and sign
                    off on itself, so Camus pairs it with Codex, made by a competitor, and abides by
                    its verdict. The pairing is the point.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-crossing.svg" alt="A cover study after The First Man" width="400" height="600" />
              </div>
            </Reveal>

            <div className="evs">
              <Reveal className="ev">
                <p className="ev-cap">
                  The review comes from Codex, built by a competitor.{' '}
                  <em>Claude relays its verdict and abides by it.</em>
                </p>
                <Artifact tone="dark" path="~/.camus/reviews/harden-x1f9q2-r1.json" label="A Codex review verdict">
{`{
  `}<span className="k">&quot;ran&quot;</span>{`: true,
  `}<span className="k">&quot;clean&quot;</span>{`: `}<span className="rej">false</span>{`,
  `}<span className="k">&quot;blocking&quot;</span>{`: [
    { `}<span className="k">&quot;priority&quot;</span>{`: 1, `}<span className="k">&quot;title&quot;</span>{`: "missing empty-input guard" }
  ]
}`}
                </Artifact>
              </Reveal>

              <Reveal className="ev">
                <p className="ev-cap">
                  A clean review still has to clear the repo&apos;s own checks — and the
                  verdict names the commit it ran against.{' '}
                  <em>A green run means real checks passed on that exact commit.</em>
                </p>
                <Artifact tone="dark" path="camus verify" label="A verification run">
{`$ pnpm type-check     `}<span className="ok">ok</span>{`
$ pnpm test           `}<span className="ok">ok</span>{`   163 passed
→ done · commit a1f9c2e · `}<span className="ok">head-bound: a1f9c2e</span>{``}
                </Artifact>
              </Reveal>

              <Reveal className="ev">
                <p className="ev-cap">
                  Every judgment call is logged with its reason and the option it rejected.{' '}
                  <em>You can read the reasoning, change by change.</em>
                </p>
                <Artifact path="~/.camus/reports/harden-input-boundaries.json" label="A decision in the run report">
{`  `}<span className="k">&quot;decisions&quot;</span>{`: [
    {
      `}<span className="k">&quot;what&quot;</span>{`:     "widened content type to unknown",
      `}<span className="k">&quot;why&quot;</span>{`:      "callers pass non-string payloads",
      `}<span className="k">&quot;rejected&quot;</span>{`: "a string-only guard"
    }
  ]`}
                </Artifact>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec" id="autonomy">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">
                    Unattended,<br />
                    <em>and accountable.</em>
                  </h2>
                  <p className="sec-sub">
                    It stays quiet when that is safe, and asks a real question when a task is
                    genuinely ambiguous. Your answer resumes the same run.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-break.svg" alt="A cover study after The Rebel" width="400" height="600" />
              </div>
            </Reveal>

            <Reveal>
              <div className="pol">
                <b>autonomous</b>
                <span>·</span>
                <span>
                  <b>ask_on_ambiguity</b> (default)
                </span>
                <span>·</span>
                <b>ask_on_major</b>
              </div>
            </Reveal>

            <div className="evs">
              <Reveal className="ev">
                <p className="ev-cap">
                  When a call is genuinely ambiguous, it stops and asks you. <em>Your answer resumes the run.</em>
                </p>
                <Artifact path="~/.camus/reports/feat-9c2.json" label="A run paused for a human">
{`  `}<span className="k">&quot;status&quot;</span>{`:   `}<span className="rej">&quot;needs_human&quot;</span>{`,
  `}<span className="k">&quot;question&quot;</span>{`: "Two callers expect different shapes.
              Which contract should win?"`}
                </Artifact>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec" id="stop">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">It knows when to stop.</h2>
                  <p className="sec-sub">
                    Review rounds are capped, and a finding that survives its own fix stops the loop
                    early. When review stalls but your tests stay green, that becomes a decision on
                    your desk — with the reviewer&apos;s own conviction trend as context.
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="evs">
              <Reveal className="ev">
                <p className="ev-cap">
                  A re-raised finding with falling reviewer conviction reads as a stale flag, so the
                  loop stops and shows its work. <em>You get a decision, not churn.</em>
                </p>
                <Artifact path="~/.camus/feats/harden-x1f9q2.json" label="A run stopped for a decision">
{`  `}<span className="k">&quot;status&quot;</span>{`:      `}<span className="rej">&quot;needs_decision&quot;</span>{`,
  `}<span className="k">&quot;verifyClean&quot;</span>{`: true,
  `}<span className="k">&quot;stuck&quot;</span>{`: [{ `}<span className="k">&quot;title&quot;</span>{`: "missing empty-input guard",
              `}<span className="k">&quot;confidenceTrend&quot;</span>{`: { `}<span className="k">&quot;dir&quot;</span>{`: "falling", `}<span className="k">&quot;series&quot;</span>{`: [0.9, 0.8] } }]`}
                </Artifact>
              </Reveal>

              <Reveal className="ev">
                <p className="ev-cap">
                  Kill the run anywhere. Finished tasks skip, proven work lands itself through commit
                  and verify, and only unproven work re-runs. <em>Nothing re-implements what is already proven.</em>
                </p>
                <Artifact tone="dark" path="camus resume" label="A resume after a crash mid-merge">
{`prior state: `}<span className="k">&quot;ready_to_merge&quot;</span>{`   `}<span className="c"># killed between commit and merge</span>{`
▸ Task 1 — LAND (resuming interrupted merge) → commit → verify → merge…
`}<span className="ok">✓</span>{` merged a1f9c2e · zero review rounds spent`}
                </Artifact>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="sec" id="philosophy">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Bigger than code.</h2>
                  <p className="sec-sub">
                    It is built for code, but the principle is bigger: nothing should be the judge of
                    its own work.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-cascade.svg" alt="A cover study after The Myth of Sisyphus" width="400" height="600" />
              </div>
            </Reveal>
            <Reveal>
              <div className="creed">
                <p><em>A craftsman knows how to work. An artist knows when to stop.</em></p>
                <p>
                  Underneath, it treats agent work the way a database treats a transaction:
                  every handoff carries evidence, every green names the state it certified,
                  and a halt preserves the proof instead of the mess.
                </p>
                <p>
                  An agent can always run one more round, so Camus treats stopping as judgment:
                  it tells one more round from a decision worth a human, because perfection is out
                  of reach and knowing when to stop is not.
                </p>
                <p>It runs on two rival models, so every change answers to an outside reviewer.</p>
                <p>It runs unwatched, so the checks are what let you trust a green run.</p>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="run">
          <div className="wrap">
            <Reveal>
              <div className="sec-head">
                <div>
                  <h2 className="sec-h2">Run it.</h2>
                  <p className="sec-sub">
                    It runs in Claude Code today: a subscription, the Codex CLI authenticated, node,
                    python3, and a repo you trust.
                  </p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="sec-art" src="/brand/covers/the-descent.svg" alt="A cover study after The Fall" width="400" height="600" />
              </div>
            </Reveal>
            <Reveal>
              <div className="term">
                <pre>
{`# one-time
$ npm i -g camus-cli
$ camus install        `}<span className="c"># a frozen copy into ~/.claude — what you ran is what runs</span>{`
$ camus auto-setup     `}<span className="c"># opt-in scoped unattended profile</span>{`

# per run, from your repo
$ camus check          `}<span className="c"># installed == package, safe to run</span>{`
$ camus canary         `}<span className="c"># optional: prove the toolchain on a throwaway repo first</span>{`
$ claude --permission-mode auto

> /camus-feat { feat: "Harden input boundaries", tasks: [...] }
`}<span className="o">✓</span>{` env + baseline · 3/3 tasks done · integration verify green, head-bound`}
                </pre>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec closing" id="camus">
          <div className="wrap">
            <Reveal>
              <figure className="closing-mark">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/covers/the-climb.svg" alt="The Camus loop, held as a still" width="400" height="600" />
                <figcaption>Camus</figcaption>
              </figure>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
