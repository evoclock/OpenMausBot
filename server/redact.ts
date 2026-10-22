// Native protocol logs keep the shape of credentials, never their values: they get pasted into issues.

const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "omb_gate_upstream" || lower === "omb_remote_mcp_server" || lower.startsWith("omb_remote_mcp_config_")) return true;
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

import { mask, redactSecretsInText } from "../shared/redact.ts";
import type { WireMessage } from "../shared/wire.ts";

export { addHeldSecretScrubber, HELD_SECRET_MASK, mask, redactSecretsInText, scrubHeldSecrets } from "../shared/redact.ts";

const SENSITIVE_FILE = new RegExp(String.raw`(?:^|[/\\\s"'=])(?:\.env(?:\.[\w.-]+)?|\.ssh[/\\](?:id_[\w.-]+|config)|\.aws[/\\]credentials|\.npmrc|\.netrc|[\w.-]+\.keychain(?:-db)?|service[-_]account[\w.-]*\.json)(?=$|[/\\\s"':,;])`, "i");
const RESULT_KEY_VALUE = /\b((?:[A-Za-z0-9_-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?)(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]+)\3/gi;
const SENSITIVE_INPUT = "«redacted sensitive file input»";
const SENSITIVE_RESULT = "«redacted sensitive file result»";

export function redactToolInput(text: string): string {
  return SENSITIVE_FILE.test(text) ? SENSITIVE_INPUT : redactSecretsInText(text);
}

export function redactToolResult(text: string, input = ""): string {
  if (input === SENSITIVE_INPUT || SENSITIVE_FILE.test(input) || SENSITIVE_FILE.test(text)) return SENSITIVE_RESULT;
  return redactSecretsInText(text).replace(RESULT_KEY_VALUE,
    (_whole, key: string, separator: string, quote: string, value: string) => `${key}${separator}${quote}${mask(value)}${quote}`);
}

export function redactToolFields(tool: NonNullable<WireMessage["tool"]>): NonNullable<WireMessage["tool"]> {
  const input = tool.input ?? tool.name;
  return {
    ...tool,
    name: redactToolInput(tool.name),
    ...(tool.input === undefined ? {} : { input: redactToolInput(tool.input) }),
    ...(tool.summary === undefined ? {} : { summary: redactToolResult(tool.summary, input) }),
    ...(tool.output === undefined ? {} : { output: redactToolResult(tool.output, input) }),
    ...(tool.spoken === undefined ? {} : { spoken: redactToolInput(tool.spoken) }),
  };
}

export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
  if (depth > 12 || input === null || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string };
        // A non-secret name does not clear the value: it still gets the content pass.
        return isSecretName(entry.name)
          ? { ...entry, value: mask(entry.value) }
          : { ...entry, value: redactSecretsInText(entry.value) };
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
