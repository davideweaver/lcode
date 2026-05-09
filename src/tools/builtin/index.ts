import type { Tool } from '../types.js';
import { BashTool } from './bash.js';
import { EditTool } from './edit.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { ReadTool } from './read.js';
import { TaskTool } from './task.js';
import { WebFetchTool } from './web-fetch.js';
import { WebSearchTool } from './web-search.js';
import { WriteTool } from './write.js';

export const BUILTIN_TOOLS: Tool[] = [
  ReadTool,
  WriteTool,
  EditTool,
  GlobTool,
  GrepTool,
  BashTool,
  WebFetchTool,
  WebSearchTool,
  TaskTool,
];

export {
  BashTool,
  EditTool,
  GlobTool,
  GrepTool,
  ReadTool,
  TaskTool,
  WebFetchTool,
  WebSearchTool,
  WriteTool,
};
