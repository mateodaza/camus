import { SiteNav } from './components/SiteNav';
import { SiteFooter } from './components/SiteFooter';
import { ClimbLoop } from './components/ClimbLoop';
import { Artifact } from './components/Artifact';
import { Reveal } from './components/Reveal';
import { CoverMark } from './components/CoverMark';

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
              A different model reviews every change. Your own tests have the final word.
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
              <h2 className="sec-h2">Watch it work.</h2>
              <p className="sec-sub">
                It ships as a skill and two workflows, so it runs wherever skills run. Every phase of
                every task is on screen as it happens.
              </p>
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
              <h2 className="sec-h2">No step approves its own work.</h2>
              <p className="sec-sub">
                Most agent loops are maker and checker from the same vendor. Camus separates them,
                and leaves the receipts.
              </p>
            </Reveal>

            <div className="evs">
              <Reveal className="ev">
                <p className="ev-cap">
                  The review comes from a different vendor&apos;s model, relayed word for word.{' '}
                  <em>Claude never re-judges it.</em>
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
                  A clean review still does not ship code that fails the repo&apos;s own checks.{' '}
                  <em>No verifier found is a failure, not a pass.</em>
                </p>
                <Artifact tone="dark" path="camus verify" label="A verification run">
{`$ pnpm type-check     `}<span className="ok">ok</span>{`
$ pnpm test           `}<span className="ok">ok</span>{`   163 passed
→ done · commit a1f9c2e`}
                </Artifact>
              </Reveal>

              <Reveal className="ev">
                <p className="ev-cap">
                  Every judgment call is logged with its reason and the path not taken.{' '}
                  <em>You review decisions, not just diffs.</em>
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
              <h2 className="sec-h2">
                Unattended, <em>not unaccountable.</em>
              </h2>
              <p className="sec-sub">
                No prompts when that is safe. A real question when a task is genuinely ambiguous,
                and your answer resumes the same run.
              </p>
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
                  When it genuinely cannot decide, it stops and asks. <em>It does not guess.</em>
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

        <section className="sec cover-sec" id="philosophy">
          <div className="wrap">
            <Reveal>
              <div className="cover-grid">
                <CoverMark />
                <div className="cover-text">
                  <h2 className="sec-h2">Bigger than code.</h2>
                  <p className="sec-sub">
                    Camus is built for code. The harder question underneath is how far you can trust
                    an agent that runs on its own.
                  </p>
                  <div className="creed">
                    <p>An agent can do the work. It can&apos;t be the one who decides the work is good.</p>
                    <p>
                      You set how far it goes alone: all the way to a commit, or it stops and asks
                      when a task is genuinely unclear, or only on the calls that are big.
                    </p>
                    <p>
                      It keeps a record of what it changed, why, the option it rejected, and every
                      review. You read the decisions, not just the diff.
                    </p>
                    <p>It never really finishes. The boulder rolls back down, and the checks are what keep each run honest.</p>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="sec" id="run">
          <div className="wrap">
            <Reveal>
              <h2 className="sec-h2">Run it.</h2>
              <p className="sec-sub">
                It runs in Claude Code today: a subscription, the Codex CLI authenticated, node,
                python3, and a repo you trust.
              </p>
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
      </main>
      <SiteFooter />
    </>
  );
}
