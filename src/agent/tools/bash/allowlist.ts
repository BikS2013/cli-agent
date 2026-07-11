/**
 * Bash allowlist parser and matcher.
 *
 * Allowlist entry kinds:
 *  - Binary name: "git" — matches any invocation of the git binary
 *  - argv-regex: "argv-regex:^git (status|diff)$" — matches specific invocations
 *
 * UNRESTRICTED default (2026-07-04, user-directed change): when NO entry is
 * configured anywhere (no --bash-allow / --bash-allow-file /
 * BASH_ALLOWED_COMMANDS / config bash.allow, and no wrapped --tool), the
 * matcher is UNRESTRICTED — `test()` accepts every command. The moment ANY
 * entry exists, matching is restrictive exactly as before (OR'd entries).
 * `isEmpty()` reports the unrestricted state so callers can surface it
 * (stderr notice, system prompt, bash_list_allowed).
 *
 * argv-regex patterns are NEVER echoed back in error messages (may contain tokens).
 */

export type AllowlistEntry =
  | { kind: 'binary'; name: string }
  | { kind: 'argv-regex'; pattern: RegExp };

export interface AllowlistMatcher {
  test(command: string, args: ReadonlyArray<string>): boolean;
  getBinaryNames(): string[];
  isEmpty(): boolean;
}

export function parseAllowlistEntries(raw: string[]): AllowlistEntry[] {
  return raw.map((entry) => {
    if (entry.startsWith('argv-regex:')) {
      const pattern = entry.slice('argv-regex:'.length);
      return { kind: 'argv-regex' as const, pattern: new RegExp(pattern) };
    }
    return { kind: 'binary' as const, name: entry.trim() };
  });
}

export function buildAllowlistMatcher(entries: AllowlistEntry[]): AllowlistMatcher {
  return {
    test(command: string, args: ReadonlyArray<string>): boolean {
      // Unrestricted mode: no configured entries ⇒ every command is
      // permitted (fail-open by explicit user decision, 2026-07-04).
      if (entries.length === 0) return true;
      const cmdBasename = command.split('/').pop() ?? command;
      for (const entry of entries) {
        if (entry.kind === 'binary') {
          if (entry.name === cmdBasename || entry.name === command) return true;
        } else {
          const argv = [command, ...args].join(' ');
          if (entry.pattern.test(argv)) return true;
        }
      }
      return false;
    },
    getBinaryNames(): string[] {
      return entries
        .filter((e): e is { kind: 'binary'; name: string } => e.kind === 'binary')
        .map((e) => e.name);
    },
    isEmpty(): boolean {
      return entries.length === 0;
    },
  };
}
