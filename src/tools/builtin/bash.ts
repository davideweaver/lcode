import { spawn } from 'node:child_process';
import { z } from 'zod';
import { tool } from '../helper.js';

const schema = z.object({
  command: z.string().describe('Shell command to run (executed via /bin/sh -c).'),
  description: z
    .string()
    .optional()
    .describe('Short description of what the command does (for the operator).'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('Timeout in milliseconds (default 120000, max 600000).'),
});

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 200_000;

export const BashTool = tool(
  'Bash',
  'Execute a shell command via /bin/sh -c. Captures stdout and stderr. ' +
    'Default timeout 2 minutes; configurable up to 10 minutes. Runs in the session cwd. ' +
    'Use cd && cmd patterns if you need to operate from a different directory.',
  schema,
  async (input, ctx) => {
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    return new Promise((res) => {
      const proc = spawn('/bin/sh', ['-c', input.command], {
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, timeoutMs);

      proc.stdout.on('data', (b) => {
        stdout += b.toString();
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT) + '\n…(stdout truncated)';
          proc.stdout.removeAllListeners('data');
        }
      });
      proc.stderr.on('data', (b) => {
        stderr += b.toString();
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT) + '\n…(stderr truncated)';
          proc.stderr.removeAllListeners('data');
        }
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        res({ content: `Error: failed to spawn shell: ${e.message}`, isError: true });
      });
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        const parts: string[] = [];
        if (stdout) parts.push(stdout.trimEnd());
        if (stderr) parts.push(`[stderr]\n${stderr.trimEnd()}`);
        if (timedOut) parts.push(`[timed out after ${timeoutMs}ms; SIGKILL]`);
        else if (signal) parts.push(`[terminated by ${signal}]`);
        else if (code !== 0) parts.push(`[exit ${code}]`);
        const content = parts.join('\n').trim() || '(no output)';
        res({ content, isError: timedOut || (code !== 0 && code !== null) });
      });
    });
  },
);
