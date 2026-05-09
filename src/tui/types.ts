export type UiBlock =
  | { kind: 'user_prompt'; text: string }
  | { kind: 'assistant_text'; text: string; streaming: boolean }
  | {
      kind: 'thinking';
      text: string;
      streaming: boolean;
      startedAt: number;
      durationMs?: number;
    }
  | {
      kind: 'tool_call';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: 'pending' | 'done' | 'error';
      result?: string;
      /**
       * Live sub-agent activity, populated only when this tool_call is a
       * `Task` invocation. Each entry mirrors a tool the sub-agent ran;
       * statuses flip to 'done'/'error' when the matching tool_result
       * event arrives. Drives the nested rendering under the parent's
       * Task block.
       */
      subagentActivity?: {
        initialized: boolean;
        /** Streaming text accumulated from the sub-agent's current LLM call. */
        currentText: string;
        tools: {
          id: string;
          name: string;
          input: Record<string, unknown>;
          status: 'pending' | 'done' | 'error';
        }[];
      };
    }
  | { kind: 'result'; subtype: string; text?: string }
  | { kind: 'error'; text: string }
  | { kind: 'slash_output'; text: string }
  | {
      kind: 'compaction';
      subtype: 'tier1' | 'tier2';
      savedTokens: number;
      summary?: string;
    };
