const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*\s*=\s*(?:"[^"\r\n]{12,}"|'[^'\r\n]{12,}'|`[^`\r\n]{12,}`|[A-Za-z0-9_./+=-]{20,})/gi;
const SECRET_PATTERNS = [OPENAI_SECRET_PATTERN, SECRET_ASSIGNMENT_PATTERN];

export function hasSecretValue(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0])) return true;
    }
  }
  return false;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => isPlaceholderSecret(match) ? match : redactSecretAssignment(match))
    .replace(OPENAI_SECRET_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
}

const SENSITIVE_KEY_RE = /^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|password|passwd|private[_-]?key)$/i;
const INTERNAL_LEASE_TOKEN_KEYS = new Set([
  "lease_token",
  "workspace_lease_token",
  "mutation_lease_token"
]);

export function isInternalLeastTokenKey(key: string): boolean {
  return INTERNAL_LEASE_TOKEN_KEYS.has(key.trim().toLowerCase());
}

export function isSensitiveKey(key: string): boolean {
  if (isInternalLeastTokenKey(key)) return false;
  if (SENSITIVE_KEY_RE.test(key)) return true;
  const lower = key.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.endsWith("token") ||
    lower.endsWith("apikey") ||
    lower.endsWith("api_key") ||
    lower.endsWith("api-key")
  );
}

export function redactStructured<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      out[key] = "[REDACTED_SECRET]";
    } else {
      out[key] = redactStructured(item, depth + 1);
    }
  }
  return out as T;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("[redacted_secret]") ||
    normalized.includes("replace-me") ||
    normalized.includes("your-api-key-here") ||
    normalized.includes("<openai_api_key>") ||
    normalized.includes("process.env.") ||
    normalized.includes("import.meta.env.") ||
    normalized.includes("os.environ") ||
    normalized.includes("getenv(") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}

function redactSecretAssignment(value: string): string {
  const index = value.indexOf("=");
  if (index < 0) return "[REDACTED_SECRET]";
  return `${value.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
}
