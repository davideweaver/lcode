import type { Tool } from '../types.js';
import { BashTool } from './bash.js';
import { EditTool } from './edit.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';

export const BUILTIN_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  GlobTool,
  GrepTool,
  BashTool,
];

export { BashTool, EditTool, GlobTool, GrepTool, ReadTool, WriteTool };
