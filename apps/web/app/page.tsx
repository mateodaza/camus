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
              <span className="tagline">A coding loop that proves every change.</span>
            </h1>
            <p className="hero-sub">
              A competing model reviews every change, and your own tests have the final word.
              No agent grades its own work.
            </p>
            <div className="cta-row">
              <a className="cta" href="https://www.npmjs.com/package/camus-cli">npx camus-cli install</a>
              <a className="cta-ghost" href="https://github.com/mateodaza/camus">GitHub &#8599;</a>
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
  `}<span className="k">&quot;verdict&quot;</span>{`: `}<span className="rej">&quot;REJECT&quot;</span>{`,
  `}<span className="k">&quot;blocking&quot;</span>{`: [
    { `}<span className="k">&quot;priority&quot;</span>{`: 1, `}<span className="k">&quot;note&quot;</span>{`: "missing empty-input guard" }
  ]
}`}
                </Artifact>
              </Reveal>

              <Reveal className="ev">
                <p className="ev-cap">
                  A clean review still has to clear the repo&apos;s own checks.{' '}
                  <em>A green run means real checks passed.</em>
                </p>
                <Artifact tone="dark" path="camus verify" label="A verification run">
{`$ pnpm type-check     `}<span className="ok">ok</span>{`
$ pnpm test           `}<span className="ok">ok</span>{`   163 passed
→ done · commit a1f9c2e`}
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
                <p>It runs on two rival models, so every change answers to an outside reviewer.</p>
                <p>You decide how far it runs alone, and it logs every judgment call with the reasoning behind it.</p>
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
$ camus install        `}<span className="c"># skill + workflows into ~/.claude</span>{`
$ camus auto-setup     `}<span className="c"># opt-in scoped unattended profile</span>{`

# per run, from your repo
$ camus check
$ export CAMUS_REPO_ROOT=`}<span className="o">&quot;$(pwd -P)&quot;</span>{`
$ export CAMUS_VERIFY_CMD=`}<span className="o">&quot;pnpm type-check &amp;&amp; pnpm test&quot;</span>{`
$ claude --permission-mode auto

> /camus-feat { feat: "Harden input boundaries", tasks: [...] }
`}<span className="o">✓</span>{` env + baseline · 3/3 tasks done · integration verify green`}
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
