import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

const schema = z.object({
  file_path: z.string().describe('Absolute path to the file to read.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('1-based line number to start reading from.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Number of lines to read. Defaults to 2000.'),
});

export const ReadTool = tool(
  'Read',
  'Read a file from the local filesystem. Returns content with cat -n style line numbers. ' +
    'Path must be absolute. Defaults to first 2000 lines; use offset/limit to page through larger files. ' +
    'Long lines are truncated to 2000 characters.',
  schema,
  async (input, ctx) => {
    const { file_path, offset, limit } = input;
    if (!isAbsolute(file_path)) {
      return { content: `Error: file_path must be absolute. Got: ${file_path}`, isError: true };
    }
    try {
      const info = await stat(file_path);
      if (!info.isFile()) {
        return { content: `Error: ${file_path} is not a regular file.`, isError: true };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: cannot stat ${file_path}: ${msg}`, isError: true };
    }

    let raw: string;
    try {
      raw = await readFile(file_path, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to read ${file_path}: ${msg}`, isError: true };
    }

    const lines = raw.split('\n');
    const startIdx = Math.max(0, (offset ?? 1) - 1);
    const take = limit ?? DEFAULT_LIMIT;
    const slice = lines.slice(startIdx, startIdx + take);

    const numbered = slice
      .map((line, i) => {
        const lineNum = startIdx + i + 1;
        const truncated =
          line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + ' …(truncated)' : line;
        return `${String(lineNum).padStart(6, ' ')}\t${truncated}`;
      })
      .join('\n');

    ctx.sessionState.readFiles.add(file_path);

    const tail =
      startIdx + slice.length < lines.length
        ? `\n[file has ${lines.length} lines total; showing ${startIdx + 1}-${startIdx + slice.length}]`
        : '';
    return { content: numbered + tail };
  },
  { readOnly: true },
);
