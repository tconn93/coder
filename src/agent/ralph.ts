import { generateText } from 'ai';
import { getProvider } from '../providers/index.js';
import { AgentOrchestrator } from './index.js';
import type { AgentOptions, StreamEvent } from '../types.js';

export interface RalphOptions {
  prompt: string;
  agentOptions: AgentOptions;
  maxIterations?: number;
  verifyPrompt?: string;
}

const VERIFIER_SYSTEM = `You are a verification agent. Assess whether a task was completed successfully.
Respond with exactly one of:
- "PASS: <reason>" if the task is complete and correct
- "FAIL: <reason>" if the task is incomplete or has issues`;

export async function* runRalph(opts: RalphOptions): AsyncGenerator<StreamEvent> {
  const maxIter = opts.maxIterations ?? 5;
  const orchestrator = new AgentOrchestrator(opts.agentOptions.workdir);

  for (let i = 1; i <= maxIter; i++) {
    yield { type: 'text', data: `\n[Ralph] Iteration ${i}/${maxIter}...\n` };

    let lastResult = '';
    for await (const event of orchestrator.run(opts.prompt, opts.agentOptions)) {
      yield event;
      if (event.type === 'done') {
        const done = event.data as { result: string };
        lastResult = done.result;
      }
    }

    // Verify
    const verifyMsg = opts.verifyPrompt
      ? `${opts.verifyPrompt}\n\nAgent output:\n${lastResult}`
      : `Did the agent successfully complete this task: "${opts.prompt}"?\n\nAgent output:\n${lastResult}`;

    try {
      const { text: verdict } = await generateText({
        model: getProvider(opts.agentOptions.provider, opts.agentOptions.model),
        system: VERIFIER_SYSTEM,
        messages: [{ role: 'user', content: verifyMsg }],
      });

      yield { type: 'text', data: `\n[Ralph] Verdict: ${verdict}\n` };

      const passed = /^PASS/i.test(verdict.trim()) || /success|complete|passed/i.test(verdict);
      if (passed) {
        yield { type: 'text', data: `\n[Ralph] Task verified complete after ${i} iteration(s).\n` };
        return;
      }

      if (i < maxIter) {
        yield { type: 'text', data: `\n[Ralph] Iteration ${i} did not pass, retrying...\n` };
      }
    } catch (err) {
      yield { type: 'text', data: `\n[Ralph] Verifier error: ${(err as Error).message}\n` };
    }
  }

  yield { type: 'error', data: { message: `Ralph exhausted ${maxIter} iterations without success`, code: 'RALPH_EXHAUSTED' } };
}
