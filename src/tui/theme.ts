/**
 * TUI color schemes. The launcher (bin/lcode) detects the terminal
 * background once at startup and exports the result as LCODE_THEME;
 * everything in the TUI reads it through getTheme().
 */
export type ThemeName = 'dark' | 'light';

export interface Theme {
  name: ThemeName;
  /** Background color painted behind a user-prompt block. */
  userPromptBg: string;
}

export const lightTheme: Theme = {
  name: 'light',
  userPromptBg: '#f1f1f1',
};

export const darkTheme: Theme = {
  name: 'dark',
  // ~16% white. Subtle pop against a #000–#1e1e1e terminal bg without
  // looking like an active highlight.
  userPromptBg: '#2a2a2a',
};

export function resolveThemeName(envValue: string | undefined): ThemeName {
  const v = (envValue ?? '').toLowerCase();
  return v === 'light' ? 'light' : 'dark';
}

export function getTheme(): Theme {
  return resolveThemeName(process.env.LCODE_THEME) === 'light' ? lightTheme : darkTheme;
}
