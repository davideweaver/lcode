import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const PREVIEW_LINE_LIMIT = 2000;
const PREVIEW_MAX_LINE_LENGTH = 2000;

const schema = z.object({
  file_path: z.string().describe('Absolute path to the file to write.'),
  content: z.string().describe('Full file contents. Overwrites if the file exists.'),
});

export const WriteTool = tool(
  'Write',
  'Write a file. If the file already exists and has not been Read this session, the first ' +
    'call returns the existing contents as an error so you can confirm before overwriting; ' +
    'call Write again to commit. Path must be absolute; parent directories are created.',
  schema,
  async (input, ctx) => {
    const { file_path, content } = input;
    if (!isAbsolute(file_path)) {
      return { content: `Error: file_path must be absolute. Got: ${file_path}`, isError: true };
    }
    let exists = false;
    try {
      await stat(file_path);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !ctx.sessionState.readFiles.has(file_path)) {
      // Show the model what it would clobber, mark as seen, and require a
      // second Write call to commit. Same safety semantic as requiring a
      // Read first, but folds the Read into the error response.
      ctx.sessionState.readFiles.add(file_path);
      const preview = await previewExisting(file_path);
      return {
        content:
          `Error: ${file_path} already exists. Confirm the contents below, then call Write ` +
          `again to overwrite.\n\n${preview}`,
        isError: true,
      };
    }
    try {
      await mkdir(dirname(file_path), { recursive: true });
      await writeFile(file_path, content, 'utf8');
      ctx.sessionState.readFiles.add(file_path);
      return { content: `${exists ? 'Updated' : 'Created'} ${file_path} (${content.length} chars).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to write ${file_path}: ${msg}`, isError: true };
    }
  },
);

async function previewExisting(file_path: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(file_path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `(could not read existing contents: ${msg})`;
  }
  const lines = raw.split('\n');
  const slice = lines.slice(0, PREVIEW_LINE_LIMIT);
  const numbered = slice
    .map((line, i) => {
      const truncated =
        line.length > PREVIEW_MAX_LINE_LENGTH
          ? line.slice(0, PREVIEW_MAX_LINE_LENGTH) + ' …(truncated)'
          : line;
      return `${String(i + 1).padStart(6, ' ')}\t${truncated}`;
    })
    .join('\n');
  const tail =
    slice.length < lines.length
      ? `\n[file has ${lines.length} lines total; showing 1-${slice.length}]`
      : '';
  return numbered + tail;
}
