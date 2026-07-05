// src/memory/sanitizer.ts
//
// Reversible encoding for sensitive data.
// On remember(): encode → write encoded to disk.
// On assemble(): read → decode → Agent sees plaintext.
//
// PII (names, emails, phones, employee IDs) → one-way redaction (never needed back).
// Credentials & IPs → reversible encoding (Agent may need these).

const ENC_PREFIX = '{enc:';
const ENC_SUFFIX = '}';

function encodeValue(plain: string): string {
  return ENC_PREFIX + Buffer.from(plain, 'utf-8').toString('base64') + ENC_SUFFIX;
}

const ENC_RE = /\{enc:[A-Za-z0-9+/=]+\}/g;

export function decode(text: string): string {
  return text.replace(ENC_RE, (match) => {
    const inner = match.slice(ENC_PREFIX.length, -ENC_SUFFIX.length);
    try {
      return Buffer.from(inner, 'base64').toString('utf-8');
    } catch {
      return match; // corrupt marker, leave as-is
    }
  });
}

// ── Rules ──

interface Rule {
  name: string;
  /** Detects the sensitive value (may include context like key=). */
  pattern: RegExp;
  /**
   * encode: given the full match, return [encodedMatch, humanLabel].
   * PII rules return [redactedPlaceholder, ruleName] — one-way.
   * Credential/IP rules return [encodeValue(sensitivePart), ruleName] — reversible.
   */
  encode: (match: string) => [string, string];
}

const RULES: Rule[] = [
  // ── Reversible: credentials ──
  {
    name: 'credential',
    pattern: /(password|passwd|token|api_key|secret|access_key)(\s*[:=]\s*)(\S+)/gi,
    encode: (m: string) => {
      const parts = m.match(/^([a-z_]+)(\s*[:=]\s*)(.+)$/i);
      if (!parts) return [encodeValue(m), 'credential'];
      return [`${parts[1]}${parts[2]}${encodeValue(parts[3])}`, parts[1]];
    },
  },
  // ── Reversible: IP addresses ──
  {
    name: 'ip',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    encode: (m: string) => {
      const parts = m.split('.').map(Number);
      if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
        return [encodeValue(m), 'ip'];
      }
      return [m, '']; // not a valid IP, skip
    },
  },
  // ── One-way: email ──
  {
    name: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    encode: () => ['[EMAIL]', 'email'],
  },
  // ── One-way: phone ──
  {
    name: 'phone',
    pattern: /1[358]\d{9}/g,
    encode: () => ['[PHONE]', 'phone'],
  },
  // ── One-way: Chinese name ──
  {
    name: 'chinese-name',
    pattern: /(姓名|名字|我是)\s*[一-龥]{2,4}/g,
    encode: (m: string) => {
      const prefix = m.match(/^(姓名|名字|我是)/);
      return [`${prefix ? prefix[0] : ''}[姓名]`, 'chinese-name'];
    },
  },
  // ── One-way: employee ID ──
  {
    name: 'employee-id',
    pattern: /(工号|employee_id\s*[:=])\s*(\S+)/gi,
    encode: (m: string) => {
      const parts = m.match(/^([a-z_]+\s*[:=])\s*(.+)$/i) || m.match(/^(工号)\s*(.+)$/);
      if (!parts) return ['[ID]', 'employee-id'];
      return [`${parts[1]} [ID]`, 'employee-id'];
    },
  },
];

// ── Public API ──

export interface SanitizeResult {
  content: string;
  warnings: string[];
  isEmpty: boolean;
}

function applyEncode(text: string): { result: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = text;

  for (const rule of RULES) {
    const matches = result.match(rule.pattern);
    if (!matches) continue;

    const seen = new Set<string>();
    for (const m of matches) {
      const [encoded, label] = rule.encode(m);
      if (!label) continue; // skip invalid matches (e.g., non-IP that looks like one)
      result = result.replace(m, encoded);
      seen.add(label);
    }

    if (seen.size > 0) {
      warnings.push(`encoded ${[...seen].join(', ')}`);
    }
  }

  return { result, warnings };
}

export function encode(text: string, description: string): SanitizeResult {
  const contentResult = applyEncode(text);
  const descResult = applyEncode(description);

  const allWarnings = [
    ...contentResult.warnings,
    ...descResult.warnings.map(w => `in description: ${w}`),
  ];

  // Check if after encoding, content is effectively empty
  const stripped = contentResult.result
    .replace(ENC_RE, '')
    .replace(/\[EMAIL\]|\[PHONE\]|\[姓名\]|\[ID\]/g, '')
    .trim();
  const isEmpty = stripped.length === 0;

  return { content: contentResult.result, warnings: allWarnings, isEmpty };
}
