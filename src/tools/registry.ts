import type { Tool } from './types.js';

export class ToolRegistry {
  private byName = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  list(): Tool[] {
    return [...this.byName.values()];
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Filter by allow/disallow lists; both are matched as exact tool names. */
  filtered(opts: { allow?: string[]; disallow?: string[] }): Tool[] {
    const { allow, disallow } = opts;
    return this.list().filter((t) => {
      if (allow && allow.length > 0 && !allow.includes(t.name)) return false;
      if (disallow && disallow.includes(t.name)) return false;
      return true;
    });
  }
}
