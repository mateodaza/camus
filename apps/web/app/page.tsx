function SlopeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <polygon points="0,120 120,120 120,0" fill="#0B0B16" />
      <circle cx="63" cy="33" r="19" fill="#0B0B16" />
    </svg>
  );
}

function RoundsDivider() {
  return (
    <div className="divider" aria-hidden="true">
      <svg viewBox="0 0 168 84" xmlns="http://www.w3.org/2000/svg">
        <polygon points="0,56 56,56 56,0" fill="#0B0B16" />
        <polygon points="56,84 84,84 84,56" fill="#0B0B16" />
        <polygon points="84,84 98,84 98,70" fill="#0B0B16" />
      </svg>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <nav>
        <div className="wrap nav-row">
          <a className="lockup" href="#" aria-label="Camus">
            <SlopeMark />
            <span>CAMUS</span>
          </a>
          <div className="nav-links">
            <a href="#honesty">The gates</a>
            <a href="#autonomy">Autonomy</a>
            <a href="#run">Run it</a>
          </div>
        </div>
      </nav>

      <header>
        <svg
          className="hero-tri"
          viewBox="0 0 120 120"
          preserveAspectRatio="xMaxYMid slice"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <polygon points="0,120 120,120 120,0" fill="#0B0B16" />
          <circle cx="63" cy="33" r="19" fill="#0B0B16" />
        </svg>
        <div className="wrap">
          <h1>
            An autonomous coding loop that <em>can&apos;t grade its own homework.</em>
          </h1>
          <p className="sub">
            Camus runs your coding tasks from plan to verified commit, unattended. Claude writes
            the code. Codex, a different vendor&apos;s model, reviews every change. Your own tests
            have the final word.
          </p>
          <div className="hero-cta">
            <a className="btn primary" href="#run">
              npx camus-cli install
            </a>
          </div>
        </div>
      </header>

      <div className="loop">
        <div className="wrap">
          <div className="loop-row">
            <span className="stage">plan</span>
            <span className="arr">→</span>
            <span className="stage">implement</span>
            <span className="arr">→</span>
            <span className="stage codex">codex review</span>
            <span className="arr">⇄</span>
            <span className="stage">fix</span>
            <span className="arr">→</span>
            <span className="stage">commit gate</span>
            <span className="arr">→</span>
            <span className="stage det">verify: types + tests</span>
            <span className="arr">→</span>
            <span className="stage det">done</span>
          </div>
          <div className="loop-note">
            loops while <b>P0 / P1 / P2</b> findings remain · round cap 3 · every round leaves an
            audit file on disk
          </div>
        </div>
      </div>

      <section id="honesty">
        <div className="wrap">
          <RoundsDivider />
          <h2>How it stays honest</h2>
          <p className="lede">
            Most agent loops are maker and checker from the same vendor. Camus separates them.
          </p>
          <div className="grid">
            <div className="cell">
              <h3>Cross-vendor review</h3>
              <p>
                The reviewer is <code>codex</code>, not another Claude. A thin runner relays its
                JSON verbatim; Claude never re-judges the verdict. Each round gets a fresh Codex
                session, so findings are re-raised.
              </p>
            </div>
            <div className="cell">
              <h3>Tests have the last word</h3>
              <p>
                A clean review doesn&apos;t ship code that fails <code>type-check</code> or{' '}
                <code>test</code>. If no verifier is found, that is a failure, not a pass.
              </p>
            </div>
            <div className="cell">
              <h3>Infra failure ≠ findings</h3>
              <p>
                Codex not running is <code>ran:false</code>: retried, never treated as a rejection
                or a pass. Missing deps is <code>verify_inconclusive</code>, not broken code.
              </p>
            </div>
            <div className="cell">
              <h3>Work provably lands</h3>
              <p>
                A commit gate after review: nothing staged means <code>no_changes</code>, never a
                task silently marked done. Every <code>done</code> carries its{' '}
                <code>commit_sha</code>.
              </p>
            </div>
            <div className="cell">
              <h3>Reviews leave receipts</h3>
              <p>
                Every round writes Codex&apos;s raw output to <code>~/.camus/reviews/</code>. A
                missing file means the review never ran.
              </p>
            </div>
            <div className="cell">
              <h3>Scripts stay in bounds</h3>
              <p>
                Every gate script is bound to the calling repo, <code>camus/*</code> branches and{' '}
                <code>camus-wt-*</code> worktrees. Anything else is rejected.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="autonomy">
        <div className="wrap">
          <h2>Autonomy, bounded</h2>
          <p className="lede">
            No permission prompts when that&apos;s safe. A question when a task is genuinely
            ambiguous.
          </p>
          <ul className="rules">
            <li>
              <span className="n">i</span>
              <div>
                <b>Zero-click runs</b>
                <p>
                  One egress trust line and allow rules for five gate scripts. Not{' '}
                  <code>bypassPermissions</code>, no broad shell access.
                </p>
              </div>
            </li>
            <li>
              <span className="n">ii</span>
              <div>
                <b>Three policies</b>
                <p>
                  <code>autonomous</code> · <code>ask_on_ambiguity</code> (default) ·{' '}
                  <code>ask_on_major</code>. An ambiguous task halts with a question; your answer
                  resumes the same run.
                </p>
              </div>
            </li>
            <li>
              <span className="n">iii</span>
              <div>
                <b>Decisions are reported</b>
                <p>
                  Every judgment call lands in the report with the reason and the rejected
                  alternative. You review decisions, not just diffs.
                </p>
              </div>
            </li>
            <li>
              <span className="n">iv</span>
              <div>
                <b>Models are routed, then escalated</b>
                <p>
                  Trivial work goes to Sonnet, the rest to Opus. Persistent findings escalate the
                  fix model. Override with <code>model:</code> or <code>modelTier:</code>.
                </p>
              </div>
            </li>
            <li>
              <span className="n">v</span>
              <div>
                <b>Interrupted runs resume</b>
                <p>
                  Resumed with their exact original arguments. Done tasks skip; the unfinished one
                  re-runs.
                </p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <section id="run">
        <div className="wrap">
          <h2>Run it</h2>
          <p className="lede">
            You need Claude Code (subscription), the Codex CLI (authenticated), node, python3, and
            a repo you trust.
          </p>
          <div className="term">
            <pre>
              <span className="c"># one-time</span>
              {'\n'}
              <span className="p">$</span> npm i -g camus-cli
              {'\n'}
              <span className="p">$</span> camus install{'                 '}
              <span className="c"># skill + workflows → ~/.claude (frozen copy)</span>
              {'\n'}
              <span className="p">$</span> camus auto-setup{'              '}
              <span className="c"># opt-in: scoped unattended profile</span>
              {'\n\n'}
              <span className="c"># per run, from your repo</span>
              {'\n'}
              <span className="p">$</span> camus check{'                   '}
              <span className="c"># gate in sync?</span>
              {'\n'}
              <span className="p">$</span> export CAMUS_REPO_ROOT=<span className="o">&quot;$(pwd -P)&quot;</span>
              {'\n'}
              <span className="p">$</span> export CAMUS_VERIFY_CMD=
              <span className="o">&quot;pnpm type-check &amp;&amp; pnpm test&quot;</span>
              {'\n'}
              <span className="p">$</span> claude --permission-mode auto
              {'\n\n'}
              <span className="p">&gt;</span> /camus-feat{' '}
              <span className="o">{'{ feat: "Harden input boundaries", tasks: [...] }'}</span>
              {'\n'}
              <span className="g">✓</span> env + baseline · 3/3 tasks done · integration verify
              green
              {'\n'}
              <span className="g">✓</span> report → ~/.camus/reports/harden-input-boundaries-x1f9q2.json
            </pre>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          <p className="epigraph">
            The struggle itself toward the heights is enough to fill a man&apos;s heart. One must
            imagine Sisyphus happy.
          </p>
          <p className="attrib">— Albert Camus, The Myth of Sisyphus (tr. Justin O&apos;Brien)</p>
          <div className="foot-meta">
            <span>Camus — formerly Nightcrawler v2. Open source, trusted-code tool.</span>
            <a href="https://github.com/mateodaza/camus">github.com/mateodaza/camus</a>
          </div>
        </div>
      </footer>
    </>
  );
}
