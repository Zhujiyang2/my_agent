export interface FooterMessage {
  id: string;
  icon: string;
  text: string;
}

export function createFooter() {
  const messages: FooterMessage[] = [];
  let statusLine: string = '';
  const MAX_MESSAGES = 5;
  const HINT = '  /exit to quit | Ctrl+C to interrupt';

  function upsert(msg: FooterMessage): void {
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      messages[idx] = msg;
    } else {
      messages.push(msg);
      if (messages.length > MAX_MESSAGES) {
        messages.shift();
      }
    }
  }

  function remove(id: string): void {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx >= 0) {
      messages.splice(idx, 1);
    }
  }

  /** Bottom frame: separator + hints + messages (printed after Enter, before LLM output) */
  function render(): string {
    const width = process.stdout.columns || 80;
    const sep = '─'.repeat(width);

    const lines = [sep, HINT];
    for (const msg of messages) {
      lines.push(`${msg.icon} ${msg.text}`);
    }
    return lines.join('\n');
  }

  /** Top separator only (printed before rl.prompt()) */
  function renderSeparator(): string {
    const width = process.stdout.columns || 80;
    return '─'.repeat(width);
  }

  /** Optional status line rendered above the top separator (task indicator).
   *  Returns empty string when no status. */
  function renderStatusLine(): string {
    return statusLine;
  }

  /** Total lines in the frame (statusLine + top sep + bottom content). Used by
   *  InputLine to calculate cursor-up offset after rendering the full frame. */
  function frameLineCount(): number {
    // statusLine (may be multi-line) + top separator(1) + bottom.render()
    const slCount = statusLine ? statusLine.split('\n').length : 0;
    return slCount + 1 + 1 + 1 + messages.length;
  }

  function clear(): void {
    messages.length = 0;
  }

  function setStatusLine(line: string): void {
    statusLine = line;
  }

  return { upsert, remove, render, renderSeparator, renderStatusLine, clear, frameLineCount, setStatusLine };
}
