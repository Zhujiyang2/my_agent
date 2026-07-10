export const WELCOME_ART = [
  '  ┌──────────┐',
  '  │  ●    ●  │',
  '  │    ▀▀    │',
  '  └──────────┘',
].join('\n');

export function formatWelcome(): string {
  return [
    '\x1b[32m',
    '  ─── FAE Agent ───',
    '',
    WELCOME_ART,
    '',
    '  Your powerful AI assistant',
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

export function formatToolCall(name: string, args: Record<string, unknown>): string {
  const summary = summarizeArgs(name, args);
  return `\x1b[35m  🔧 ${name}\x1b[0m \x1b[90m${summary}\x1b[0m`;
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';

  // For common tools, show the most relevant arg inline
  switch (name) {
    case 'run_command':
      return truncate(String(args.command ?? ''), 80);
    case 'write_file':
      return truncate(String(args.path ?? ''), 60);
    case 'read_file':
      return truncate(String(args.path ?? ''), 60);
    case 'spawn_agent':
      return `subagent: ${truncate(String(args.task ?? ''), 60)}`;
    case 'kill_agent':
      return `kill: ${truncate(String(args.id ?? ''), 20)}`;
    case 'list_agents':
      return 'list subagents';
    case 'get_agent_result':
      return `result: ${truncate(String(args.id ?? ''), 20)}`;
    case 'check_subagent_messages':
      return 'check messages';
    case 'send_message_to_subagent':
      return `msg → ${truncate(String(args.to ?? ''), 20)}`;
    case 'glob':
      return truncate(String(args.pattern ?? ''), 60);
    default:
      return keys.map(k => `${k}=${truncate(String(args[k]), 40)}`).join(', ');
  }
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + '...';
}

export function promptConfirm(command: string, _category: string): string {
  return [
    '\x1b[31m⚠ high risk command detected:\x1b[0m',
    `  \x1b[33m${command}\x1b[0m`,
    '',
    '  [y] Execute  [n] Skip',
  ].join('\n');
}
