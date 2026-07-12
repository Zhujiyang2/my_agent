// src/tools/executor.ts

export const HIGH_RISK_PATTERNS: RegExp[] = [
  // File destruction
  /(?:^|\s)rm\b/,
  /(?:^|\s)rmdir\b/,
  /(?:^|\s)dd\b/,
  /(?:^|\s)mkfs\b/,
  /(?:^|\s)shred\b/,
  // System state
  /(?:^|\s)(?:shutdown|reboot|halt|poweroff|init)\b/,
  // Permission changes
  /(?:^|\s)chmod\b/,
  /(?:^|\s)chown\b/,
  // Process termination
  /(?:^|\s)kill\b/,
  /(?:^|\s)pkill\b/,
  /(?:^|\s)killall\b/,
  // Network changes
  /(?:^|\s)iptables\b/,
  /\bip\s+link\s+set\s+\S+\s+down\b/,
  // Disk operations
  /(?:^|\s)fdisk\b/,
  /(?:^|\s)parted\b/,
  /(?:^|\s)mount\b/,
  /(?:^|\s)umount\b/,
];

export function isHighRisk(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface ExecutorCallbacks {
  onConfirm?: (command: string, category: string) => Promise<boolean>;
}

let callbacks: ExecutorCallbacks = {};

export function setExecutorCallbacks(cbs: ExecutorCallbacks): void {
  callbacks = cbs;
}

export function getExecutorCallbacks(): ExecutorCallbacks {
  return callbacks;
}
