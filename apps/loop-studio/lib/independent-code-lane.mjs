import { runCodeSeats } from './code-seats.mjs';
import { createCodeVerifier } from './code-seat-verify.mjs';
import { codeContinuation } from './code-session.mjs';

export async function runIndependentCodeLoop(run, { emit, adapters, signal, receiptsDir, frozenBackends, authorizeCode }) {
  try {
    emit('log', { line: 'Experimental any-model Build: isolated candidate, advisory review, explicit human acceptance. No automatic commit, merge, or publication.' });
    const result = await runCodeSeats({
      repoPath: run.targetPath,
      task: `${run.goal}\n\nAcceptance contract (binding):\n${run.acceptanceContract}`,
      seats: run.models, adapters, signal, receiptsDir, backendSnapshot: frozenBackends,
      verify: createCodeVerifier(run.verifyCmd, { receiptsDir, repeatable: run.verifyRepeatable === true }),
      limits: run.codeLimits, resume: run.resumeCode === true, answer: run.codeAnswer,
      retryUncertain: run.retryUncertain === true, retryVerification: run.retryVerification === true,
      authorize: authorizeCode,
      onEvent: (event) => {
        if (event.stage) emit('stage', { name: event.stage, status: event.status ?? 'active' });
        else if (event.line) emit('session', { actor: event.actor ?? 'host', line: event.line });
      },
    });
    const status = result.status === 'needs_human' ? 'needs_decision' : result.status;
    // Deliberately not gate_report/review: those events feed the admitted-gate
    // evidence-pack schema. Experimental transport feedback cannot enter it.
    emit('code_result', { result });
    emit('code_state', { continuation: await codeContinuation(receiptsDir) });
    const markdown = [
      '# Experimental Build candidate',
      'Human acceptance required. This is not an admitted code gate.',
      `Maker: ${run.models.maker.backend}:${run.models.maker.model}`,
      `Maker executor: ${run.models.maker.codeExecutor ?? 'file_actions'}`,
      `Reviewer: ${run.models.reviewer.backend}:${run.models.reviewer.model}`,
      `Status: ${status}`,
      `Candidate worktree: ${result.candidate?.worktree ?? 'not created'}`,
      `Review: ${result.review?.verdict ?? 'unavailable'} (advisory only)`,
      `Verification: ${result.verification?.pass === true ? 'passed on this candidate' : result.verification?.pass === false ? 'failed' : 'not proven'}`,
      result.error ? `Reason: ${result.error}` : '',
      ...(result.review?.findings ?? []).map((finding) => `- ${finding.severity}: ${finding.title}\n  ${finding.detail ?? ''}`),
      '\nNothing was committed, merged, or published. Inspect the worktree and full receipt before accepting it.',
    ].filter(Boolean).join('\n\n');
    emit('revision', { rev: 1, markdown });
    emit('status', { status });
    return { ...result, status, codeMode: 'independent', experimental: true, gating: false };
  } catch (error) {
    const status = signal?.aborted ? 'stopped' : 'infra_error';
    emit('status', { status });
    return { status, codeMode: 'independent', experimental: true, gating: false, error: String(error.message || error).slice(0, 600) };
  }
}
