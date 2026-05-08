export type UiBlock =
  | { kind: 'user_prompt'; text: string }
  | { kind: 'assistant_text'; text: string; streaming: boolean }
  | {
      kind: 'tool_call';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: 'pending' | 'done' | 'error';
      result?: string;
    }
  | { kind: 'result'; subtype: string; text?: string }
  | { kind: 'error'; text: string }
  | { kind: 'slash_output'; text: string };
