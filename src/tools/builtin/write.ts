import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const schema = z.object({
  file_path: z.string().describe('Absolute path to the file to write.'),
  content: z.string().describe('Full file contents. Overwrites if the file exists.'),
});

export const WriteTool = tool(
  'Write',
  'Write a file. If the file already exists, it must have been Read first in this session ' +
    'so that you confirm what you are overwriting. Path must be absolute; parent directories are created.',
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
      return {
        content:
          `Error: ${file_path} already exists. Use Read first to confirm the current contents ` +
          `before overwriting.`,
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
