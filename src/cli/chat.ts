export const WELCOME_ART = [
  '  ┌──────────┐',
  '  │  ●    ●  │',
  '  │    ▀▀    │',
  '  └──────────┘',
].join('\n');

const EXIT_COMMANDS = new Set(['/exit', '/quit', '/q']);

export function isExitCommand(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return EXIT_COMMANDS.has(trimmed);
}

export function formatWelcome(): string {
  return [
    '\x1b[32m',
    '  ─── My Agent ───',
    '',
    WELCOME_ART,
    '',
    '  AI-powered coding assistant',
    '\x1b[0m',
  ].join('\n');
}

export function formatUserMessage(content: string): string {
  return `\x1b[36m> ${content}\x1b[0m`;
}

export function formatAssistantMessage(content: string): string {
  return `\x1b[33m${content}\x1b[0m`;
}

export function formatError(content: string): string {
  return `\x1b[31m${content}\x1b[0m`;
}

export function formatInfo(content: string): string {
  return `\x1b[90m${content}\x1b[0m`;
}
