/**
 * The privacy filter: what must never reach the store.
 *
 * Write-back reads whole conversations, and conversations contain keys. A
 * secret that lands in memory is worse than one in a log -- it will be
 * retrieved, packed into a system prompt, and sent back to a model on every
 * later question that resembles the one that captured it.
 *
 * Two levels, deliberately. `redact` masks a match and lets the item through,
 * for the cases where the surrounding sentence is still worth keeping. `reject`
 * is for items that are mostly secret, where masking leaves a memory that says
 * nothing and costs budget.
 */

export interface Rule {
  name: string;
  pattern: RegExp;
  /** `reject` drops the whole item rather than masking the match. */
  action: 'mask' | 'reject';
}

export const RULES: readonly Rule[] = [
  // Provider-shaped keys first: these are unambiguous and worth rejecting on.
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, action: 'reject' },
  { name: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g, action: 'reject' },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, action: 'reject' },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, action: 'reject' },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, action: 'reject' },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, action: 'reject' },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, action: 'reject' },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, action: 'reject' },

  // Assignment-shaped secrets: `PASSWORD=hunter2`, `api_key: "..."`. The value
  // goes, the key name stays, so the memory can still record *that* a service
  // needs credentials without recording them.
  {
    name: 'assigned-secret',
    pattern: /\b([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_]*)\s*[:=]\s*["']?([^\s"',;]{6,})["']?/gi,
    action: 'mask',
  },
  { name: 'db-url-password', pattern: /\b([a-z+]+:\/\/[^\s:@/]+):([^\s@/]+)@/gi, action: 'mask' },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, action: 'mask' },
  { name: 'authorization-header', pattern: /\bauthorization\s*:\s*\S+/gi, action: 'mask' },

  // Personal data. Not secrets, but not ours to keep either.
  { name: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g, action: 'mask' },
  { name: 'card-number', pattern: /\b(?:\d[ -]?){13,19}\b/g, action: 'mask' },
];

export interface RedactResult {
  text: string;
  /** Rule names that fired, for the audit line on the item. */
  hits: string[];
  /** True when a `reject` rule matched; the caller must not store the item. */
  rejected: boolean;
  rejectedBy: string | null;
}

const MASK = '[redacted]';

export function redact(input: string): RedactResult {
  let text = input;
  const hits: string[] = [];
  let rejectedBy: string | null = null;

  for (const rule of RULES) {
    // A global regex carries lastIndex between calls, and these are module
    // constants shared by every request. Resetting is not optional.
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text)) continue;
    rule.pattern.lastIndex = 0;
    hits.push(rule.name);

    if (rule.action === 'reject') {
      rejectedBy ??= rule.name;
      continue;
    }

    text = text.replace(rule.pattern, (match, ...groups) => {
      switch (rule.name) {
        // Keep the variable's name and lose its value.
        case 'assigned-secret': return `${groups[0]}=${MASK}`;
        case 'db-url-password': return `${groups[0]}:${MASK}@`;
        case 'email': return '[email]';
        case 'card-number':
          // The digit rule is broad by design and would eat version strings and
          // timestamps; only mask what passes the checksum a card must pass.
          return luhn(match.replace(/\D/g, '')) ? '[card]' : match;
        default: return MASK;
      }
    });
  }

  return { text, hits, rejected: rejectedBy !== null, rejectedBy };
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when text still contains something a `reject` rule would catch. */
export function looksSecret(text: string): boolean {
  return redact(text).rejected;
}
