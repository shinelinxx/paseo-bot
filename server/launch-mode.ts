export interface ParsedInvalidModeError {
  rejectedMode?: string;
  availableModes: string[];
}

function normalizeModes(modes: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of modes) {
    const clean = raw.trim();
    if (!clean || clean === "(none)" || clean === "<none>" || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function fallbackOrderForPreferredMode(preferred: string): readonly string[] {
  const lower = preferred.toLowerCase();
  if (lower === "full-access" || lower === "bypasspermissions" || lower === "bypass-permissions") {
    return [
      "full-access",
      "bypassPermissions",
      "auto",
      "accept-edits",
      "acceptEdits",
      "build",
      "default",
    ];
  }
  if (lower === "auto" || lower === "auto-review") {
    return [
      "auto",
      "accept-edits",
      "acceptEdits",
      "auto-review",
      "build",
      "default",
      "full-access",
    ];
  }
  if (lower === "accept-edits" || lower === "acceptedits") {
    return ["accept-edits", "acceptEdits", "auto", "build", "default"];
  }
  if (lower === "plan") {
    return ["plan", "default"];
  }
  return ["auto", "accept-edits", "acceptEdits", "build", "default"];
}

/**
 * Pick a valid modeId from a provider's actual available modes (which may vary per cwd).
 * Returns `undefined` when no modes are known or no compatible fallback matches,
 * allowing Paseo to fall back to the provider's own default mode.
 */
export function pickCompatibleModeId(
  preferredModeId: string | undefined,
  availableModes: readonly string[],
): string | undefined {
  const available = normalizeModes(availableModes);
  if (available.length === 0) return undefined;

  const preferred = (preferredModeId ?? "").trim();
  if (preferred && available.includes(preferred)) {
    return preferred;
  }

  for (const candidate of fallbackOrderForPreferredMode(preferred)) {
    if (available.includes(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Parse Paseo's mode validation error, e.g.:
 *   Invalid mode 'auto' for provider 'antigravity'. Available modes: default, accept-edits, plan, full-access
 */
export function parseInvalidModeError(err: unknown): ParsedInvalidModeError | null {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!message) return null;

  const fullMatch = message.match(
    /Invalid mode(?:\s+['"]([^'"]+)['"])?[^\n]*?(?:Available|Valid)\s+modes:\s*([^\n]+)/i,
  );
  if (fullMatch) {
    const rejectedMode = fullMatch[1]?.trim() || undefined;
    const availableModes = normalizeModes(
      fullMatch[2]
        .split(",")
        .map((item) => item.replace(/[.。)\]]+$/, "").trim()),
    );
    return { rejectedMode, availableModes };
  }

  const simpleMatch = message.match(/Invalid mode\s+['"]([^'"]+)['"]/i);
  if (simpleMatch) {
    return { rejectedMode: simpleMatch[1]?.trim() || undefined, availableModes: [] };
  }

  return null;
}
