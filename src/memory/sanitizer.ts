// src/memory/sanitizer.ts

export interface SanitizeResult {
  content: string;
  warnings: string[];
  isEmpty: boolean;
}

interface Rule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: Rule[] = [
  {
    name: 'credential',
    pattern: /(password|passwd|token|api_key|secret|access_key)\s*([:=])\s*\S+/gi,
    replacement: '$1$2[REDACTED]',
  },
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
  { name: 'phone', pattern: /1[358]\d{9}/g, replacement: '[PHONE]' },
  { name: 'chinese-name', pattern: /(姓名|名字|我是)\s*[一-龥]{2,4}/g, replacement: '$1[姓名]' },
  { name: 'employee-id', pattern: /(工号|employee_id\s*[:=])\s*\S+/gi, replacement: '$1 [ID]' },
  { name: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: '[IP]' },
];

function isIPAddress(s: string): boolean {
  const parts = s.split('.').map(Number);
  return parts.length === 4 && parts.every(p => p >= 0 && p <= 255);
}

function applyRules(text: string): { result: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = text;

  for (const rule of RULES) {
    if (rule.name === 'credential') {
      const credPattern = /(password|passwd|token|api_key|secret|access_key)\s*([:=]\s*)\S+/gi;
      const matches = result.match(credPattern);
      if (matches) {
        const keys = [...new Set(matches.map(m => {
          const k = m.match(/^[a-z_]+/i);
          return k ? k[0] : 'credential';
        }))];
        warnings.push(`sanitized credential(s): ${keys.join(', ')}`);
        result = result.replace(credPattern, (_m, key, sep) => `${key}${sep}[REDACTED]`);
      }
    } else if (rule.name === 'ip') {
      const matches = result.match(rule.pattern);
      if (!matches) continue;
      const ipMatches = matches.filter(m => isIPAddress(m));
      if (ipMatches.length === 0) continue;
      for (const m of ipMatches) {
        result = result.replace(m, '[IP]');
      }
      warnings.push(`sanitized ${ipMatches.length} IP address(es)`);
    } else {
      const before = result;
      result = result.replace(rule.pattern, rule.replacement);
      if (result !== before) {
        warnings.push(`sanitized ${rule.name} pattern(s)`);
      }
    }
  }

  return { result, warnings };
}

export function sanitize(content: string, description: string): SanitizeResult {
  const contentResult = applyRules(content);
  const descResult = applyRules(description);

  const allWarnings = [
    ...contentResult.warnings,
    ...descResult.warnings.map(w => `in description: ${w}`),
  ];

  const stripped = contentResult.result
    .replace(/\[REDACTED\]|\[EMAIL\]|\[PHONE\]|\[姓名\]|\[ID\]|\[IP\]/g, '')
    .trim();
  const isEmpty = stripped.length === 0;

  return { content: contentResult.result, warnings: allWarnings, isEmpty };
}
