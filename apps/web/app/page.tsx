function SlopeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <polygon points="0,120 120,120 120,0" fill="#0B0B16" />
      <circle cx="71" cy="35" r="11.5" fill="#0B0B16" />
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
          <circle cx="71" cy="35" r="11.5" fill="#0B0B16" />
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
              npx camus install
            </a>
            <a className="btn ghost" href="#honesty">
              How it stays honest
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
            Most agent loops are maker and checker from the same vendor — the fox auditing the
            henhouse. Camus structurally separates judgment from generation.
          </p>
          <div className="grid">
            <div className="cell">
              <span className="k">Gate</span>
              <h3>Cross-vendor review</h3>
              <p>
                The reviewer is <code>codex</code>, not another Claude. A thin runner relays its
                JSON verbatim — Claude never re-judges the verdict. Fresh reviewer session every
                round, so issues get re-raised, not politely dropped.
              </p>
            </div>
            <div className="cell">
              <span className="k">Gate</span>
              <h3>Deterministic verify</h3>
              <p>
                A clean review doesn&apos;t ship code that fails <code>type-check</code> or{' '}
                <code>test</code>. Stack-agnostic detection, or <code>CAMUS_VERIFY_CMD</code> — and
                if no verifier is found, that&apos;s a loud failure, never a pass.
              </p>
            </div>
            <div className="cell">
              <span className="k">Guard</span>
              <h3>Infra failure ≠ findings</h3>
              <p>
                Codex didn&apos;t run? That&apos;s <code>ran:false</code> — retried, never fed to
                the fix loop as a rejection, never counted as clean. Missing deps?{' '}
                <code>verify_inconclusive</code>, not broken code. The #1 runaway cause, fenced off.
              </p>
            </div>
            <div className="cell">
              <span className="k">Guard</span>
              <h3>Work provably lands</h3>
              <p>
                A commit gate after review-clean: nothing staged means <code>no_changes</code>,
                never a silent empty merge marked done. Every <code>done</code> carries its{' '}
                <code>commit_sha</code>.
              </p>
            </div>
            <div className="cell">
              <span className="k">Audit</span>
              <h3>Reviews leave receipts</h3>
              <p>
                Every round persists Codex&apos;s raw and parsed output to{' '}
                <code>~/.camus/reviews/</code>. A missing audit file means the binary never ran —
                fabrication is detectable.
              </p>
            </div>
            <div className="cell">
              <span className="k">Guard</span>
              <h3>Fail-closed target guard</h3>
              <p>
                Every gate script is bound to the caller&apos;s repo, <code>camus/*</code> branches
                and <code>camus-wt-*</code> worktrees. Hardened across three Codex review rounds,
                probe-verified live.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="autonomy">
        <div className="wrap">
          <RoundsDivider />
          <h2>Autonomy with a leash</h2>
          <p className="lede">
            Runs without permission prompts when that&apos;s safe. Stops and asks you when a task
            is genuinely ambiguous.
          </p>
          <ul className="rules">
            <li>
              <span className="n">i</span>
              <div>
                <b>Zero-click auto mode</b>
                <p>
                  A narrow scoped profile: one egress trust line for the review diff plus allow
                  rules for five gate scripts — not <code>bypassPermissions</code>, not broad shell
                  access. Full feature runs with zero permission prompts, proven live.
                </p>
              </div>
            </li>
            <li>
              <span className="n">ii</span>
              <div>
                <b>A policy dial, not a personality</b>
                <p>
                  <code>autonomous</code> · <code>ask_on_ambiguity</code> (default) ·{' '}
                  <code>ask_on_major</code>. Genuinely ambiguous tasks halt with a question; resume
                  threads your answer back into the same run.
                </p>
              </div>
            </li>
            <li>
              <span className="n">iii</span>
              <div>
                <b>Decisions log, always on</b>
                <p>
                  Every judgment call the loop makes — &quot;widened param type{' '}
                  <code>string → unknown</code>, because…&quot; — lands in the report with the why
                  and the rejected alternative. You review decisions, not just diffs.
                </p>
              </div>
            </li>
            <li>
              <span className="n">iv</span>
              <div>
                <b>Model control with escalation</b>
                <p>
                  A cheap classify pass routes trivial work to Sonnet, the rest to Opus. Persistent
                  review findings escalate the fix model automatically. Force it with{' '}
                  <code>model:</code> or <code>modelTier:</code> when you know better.
                </p>
              </div>
            </li>
            <li>
              <span className="n">v</span>
              <div>
                <b>Resume, don&apos;t reconstruct</b>
                <p>
                  Interrupted feature runs are detected and resumed with their canonical persisted
                  args — same policy, same answers, same scope. Done tasks skip; the unfinished one
                  re-runs.
                </p>
              </div>
            </li>
          </ul>
        </div>
      </section>

      <section id="run">
        <div className="wrap">
          <RoundsDivider />
          <h2>Run it</h2>
          <p className="lede">
            You need Claude Code (subscription), the Codex CLI (authenticated), node, python3, and
            a repo you trust. Camus is two workflows, one skill, and five audited gate scripts,
            tested by 163 stdlib assertions.
          </p>
          <div className="term">
            <pre>
              <span className="c"># one-time</span>
              {'\n'}
              <span className="p">$</span> npm i -g camus
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
