import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const schema = z.object({
  pattern: z.string().describe('Regular expression to search for (rg-flavored).'),
  path: z
    .string()
    .optional()
    .describe('Absolute path to search in. Defaults to cwd.'),
  glob: z
    .string()
    .optional()
    .describe('Glob to filter files (e.g., "*.ts").'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('content: lines with matches; files_with_matches: paths only; count: per-file counts.'),
  case_insensitive: z.boolean().optional(),
  multiline: z.boolean().optional(),
});

export const GrepTool = tool(
  'Grep',
  'Search file contents using ripgrep. Returns matching lines, file paths, or counts. ' +
    'Supports glob filtering and case-insensitive search. Path defaults to cwd.',
  schema,
  async (input, ctx) => {
    const path = input.path ?? ctx.cwd;
    if (!isAbsolute(path)) {
      return { content: `Error: path must be absolute. Got: ${path}`, isError: true };
    }
    const args: string[] = ['--no-heading', '--color', 'never'];
    if (input.case_insensitive) args.push('-i');
    if (input.multiline) args.push('-U', '--multiline-dotall');
    if (input.glob) args.push('-g', input.glob);
    const mode = input.output_mode ?? 'content';
    if (mode === 'files_with_matches') args.push('-l');
    else if (mode === 'count') args.push('-c');
    else args.push('-n');
    args.push('-e', input.pattern, '--', path);

    return new Promise((res) => {
      const proc = spawn('rg', args, { signal: ctx.signal });
      let out = '';
      let err = '';
      proc.stdout.on('data', (b) => (out += b.toString()));
      proc.stderr.on('data', (b) => (err += b.toString()));
      proc.on('error', (e) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          res({
            content:
              'Error: ripgrep (rg) not found in PATH. Install ripgrep or use Glob+Read instead.',
            isError: true,
          });
          return;
        }
        res({ content: `Error: ${e.message}`, isError: true });
      });
      proc.on('close', (code) => {
        if (code === 0) {
          res({ content: truncate(out) || '(no matches)' });
        } else if (code === 1) {
          res({ content: '(no matches)' });
        } else {
          res({
            content: `Error: rg exited ${code}: ${err.trim() || out.trim()}`,
            isError: true,
          });
        }
      });
    });
  },
  { readOnly: true },
);

const MAX_OUTPUT = 50_000;
function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n…(truncated; ${s.length - MAX_OUTPUT} bytes elided)`;
}
