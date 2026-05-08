import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const schema = z.object({
  file_path: z.string().describe('Absolute path to the file to edit.'),
  old_string: z.string().describe('Exact text to replace. Must be unique unless replace_all is true.'),
  new_string: z.string().describe('Replacement text.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences. Defaults to false.'),
});

export const EditTool = tool(
  'Edit',
  'Replace exact text in a file. The file must have been Read first. ' +
    'old_string must be unique in the file unless replace_all is true. Errors if no match.',
  schema,
  async (input, ctx) => {
    const { file_path, old_string, new_string, replace_all } = input;
    if (!isAbsolute(file_path)) {
      return { content: `Error: file_path must be absolute. Got: ${file_path}`, isError: true };
    }
    if (!ctx.sessionState.readFiles.has(file_path)) {
      return {
        content: `Error: must Read ${file_path} before editing.`,
        isError: true,
      };
    }
    if (old_string === new_string) {
      return { content: 'Error: old_string and new_string are identical.', isError: true };
    }
    let raw: string;
    try {
      raw = await readFile(file_path, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to read ${file_path}: ${msg}`, isError: true };
    }
    const occurrences = countOccurrences(raw, old_string);
    if (occurrences === 0) {
      return { content: `Error: old_string not found in ${file_path}.`, isError: true };
    }
    if (occurrences > 1 && !replace_all) {
      return {
        content:
          `Error: old_string occurs ${occurrences} times in ${file_path}. ` +
          `Add more surrounding context to make it unique, or set replace_all: true.`,
        isError: true,
      };
    }
    const updated = replace_all ? raw.split(old_string).join(new_string) : raw.replace(old_string, new_string);
    try {
      await writeFile(file_path, updated, 'utf8');
      const replaced = replace_all ? occurrences : 1;
      return { content: `Edited ${file_path} (${replaced} replacement${replaced === 1 ? '' : 's'}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to write ${file_path}: ${msg}`, isError: true };
    }
  },
);

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
