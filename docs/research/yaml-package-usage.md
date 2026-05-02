# eemeli/yaml Package — Implementation Guide for profile-codec.ts

## Overview

This document covers the `yaml` npm package (eemeli/yaml v2.x) at the depth needed to implement
`src/config/profile-codec.ts` in the cli-agent config-profiles feature. It answers seven concrete
questions raised in the investigation document (`docs/reference/investigation-config-profiles.md`),
includes copy-pasteable TypeScript patterns, and closes with a comparison to `js-yaml`.

**Package identity**

- npm: `yaml` (not `js-yaml`)
- Author: Eemeli Aro (eemeli)
- License: ISC
- Size: ~110 KB packaged, zero external dependencies
- TypeScript: first-party types bundled (no `@types/` package needed)
- YAML spec compliance: passes the full `yaml-test-suite`; supports YAML 1.1 and 1.2

---

## Key Concepts

The package exposes three API layers:

| Layer | Entry points | When to use |
|---|---|---|
| Parse & Stringify | `parse()`, `stringify()` | Read-only extraction of a typed value; no comment or structural awareness needed |
| Document API | `parseDocument()`, `parseAllDocuments()`, `Document` | Round-trip editing, comment preservation, AST inspection, or collecting errors without throwing |
| Lexer/Parser/Composer | `Lexer`, `Parser`, `Composer`, `LineCounter` | Building streaming pipelines or custom error location tooling |

For profile-codec.ts, only the first two layers are relevant.

---

## 1. `parse()` vs `parseDocument()` — When to Use Which

### `parse(str, options?): any`

Returns a plain JavaScript value (objects, arrays, primitives). Internally delegates to
`parseDocument()` and calls `.toJS()` on the result.

**Behavior on error**: Throws the first `YAMLParseError` found in `doc.errors` if the document
cannot be represented.

**Behavior on warnings**: Calls `console.warn` by default (silenceable via `logLevel: 'error'`).

**Use when**:
- You only need a plain JS value to feed into Zod `.parse()`
- You have no interest in comments, node positions, or AST manipulation
- You are willing to wrap the call in a try/catch to handle syntax errors

### `parseDocument(str, options?): Document`

Returns a `Document` object containing the full AST. Comments, anchors, blank lines, and
byte-offsets are all preserved. The function **never throws** — errors are stored in
`doc.errors[]` and warnings in `doc.warnings[]`.

**Use when**:
- You need to preserve and re-emit comments on a round-trip (profile-edit flow)
- You need structured error reporting with line/column (friendly E2 messages)
- You want to validate `doc.errors` before calling `.toJS()` so that you control the error message

**Cost difference for a 1–32 KB profile file**: negligible. Both paths run the same internal
lexer/parser/composer. The only difference is whether the intermediate `Document` object is
discarded or returned to the caller.

### Decision for profile-codec.ts

| Operation | Recommended API | Reason |
|---|---|---|
| `parseProfile()` — load profile, validate with Zod | `parseDocument()` | Collect `errors[]` before calling `.toJS()` so the codec can emit friendly line/col messages without a try/catch |
| `profile-create` — write a new stub | `stringify()` | No parsing needed; generate fresh YAML from a plain object with a comment header |
| `profile-edit` round-trip — re-validate after `$EDITOR` | `parseDocument()` | Same structured error reporting needed |
| `profile-dry-run` output | `stringify()` on the already-validated object | The display output is freshly serialized, not a round-trip of the original file |

---

## 2. Default Safety — Tags, Aliases, and Billion-Laughs

### Default schema: YAML 1.2 Core

By default the package uses the YAML 1.2 `core` schema (when no `%YAML` directive is present in
the document). Under the core schema:

- Only JSON-compatible primitives are resolved: nulls, booleans, integers, floats, and strings
- `Date` / `!!timestamp` tags are **not** resolved unless you opt in via `customTags: ['timestamp']`
- `!!binary`, `!!omap`, `!!pairs`, `!!set` are recognized by tag but treated as their base types
  unless `resolveKnownTags: true` (which is the default — see note below)
- Arbitrary JS constructor injection (the classic YAML RCE vector) is **not possible** because the
  package never calls `new Function()` or evaluates code during tag resolution

**Note on `resolveKnownTags`**: The option defaults to `true`, which means `!!timestamp` etc. are
parsed into their typed values when written explicitly as tags. For a profile file you control the
schema, so this is acceptable. If you want the strictest possible surface (only core primitives),
pass `resolveKnownTags: false`.

### Merge keys (`<<`)

YAML 1.1 merge keys (`<<: *anchor`) are **disabled by default** under the 1.2 core schema. They
must be explicitly enabled with `merge: true`. Profile files do not need merge keys, so leave
the default in place.

### Anchor/alias expansion and `maxAliasCount`

The `maxAliasCount` option (ToJS option) caps how many times an alias can be referenced when
converting the AST to a JavaScript value. The **default is 100**. An alias referenced 101 times
throws a `ReferenceError`.

This is the protection against "billion laughs" style attacks where a small YAML document expands
to a huge object graph at `.toJS()` time. At 100 references the absolute worst-case expansion is
bounded: if each alias copies a single byte, the output is at most 100× the input. In practice
the cap makes exponential blowup impossible.

```
# Example of a nested billion-laughs attempt
a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
```

With `maxAliasCount: 100`, the expansion of `c` above would throw after 100 alias resolutions
rather than producing 10^20 items. You can tighten this further:

```ts
// Completely disallow aliases (most restrictive)
parse(text, { maxAliasCount: 0 })

// Allow a small number for legitimate YAML anchors (e.g. DRY config patterns)
parse(text, { maxAliasCount: 10 })
```

### Practical attack-surface assessment for profile files

Profile files are user-authored local files, not network input. The threat model differs from
parsing untrusted remote YAML:

- **RCE via custom tags**: Not possible — the yaml package has no executable tag handlers by
  default. This is a hard architectural property, not a configurable guard.
- **Billion-laughs DoS**: The default `maxAliasCount: 100` already prevents runaway expansion.
  Lowering it to `0` or `5` for profile files is reasonable but not necessary; the 100-alias
  default means a user would have to deliberately write a malicious self-referencing profile to
  trigger even a modest slowdown, and the error is thrown rather than hanging.
- **Resource exhaustion on deeply nested documents**: Error code `RESOURCE_EXHAUSTION` is emitted
  if the document is nested so deeply it causes a stack overflow during parsing. The parser reports
  the error into `doc.errors[]` rather than crashing the process.

**Recommendation**: Use the default schema and default `maxAliasCount: 100`. For profile files the
protection is already sufficient. Document the choice so the planner knows no additional hardening
is needed.

---

## 3. Round-Trip Behavior — Comment and Ordering Preservation

### What is preserved across a parse → mutate → stringify cycle

When you use `parseDocument()` and then call `String(doc)` (or `doc.toString()`):

- **Comments are preserved** if the node they attach to has not been removed or replaced
- **Block ordering is preserved** (keys appear in the same order as in the source)
- **Blank lines** between sections are preserved via the `spaceBefore` property on nodes
- **String quoting style** (plain, single-quoted, double-quoted, block literal, block folded) is
  preserved on untouched scalars
- **Anchor names** on untouched nodes are preserved

### What can drift

The official docs include a stability note: trailing comments (comments that appear after the
last value on a line) "may be associated with different nodes upon re-parsing." This is an
implementation detail that matters only if you: (a) parse a document with trailing comments,
(b) mutate nodes, (c) re-stringify, and (d) then re-parse and compare comment placement.

For the profile-edit flow this is not a problem: the user edits the file in `$EDITOR` and the
codec only re-validates, it does not re-stringify to disk. If the codec did re-write to disk
(for example, to normalize indentation), trailing comment drift would be visible to the user.
Avoid re-writing the file after a user edit unless the user explicitly requests it.

### Round-trip code example

```ts
import { parseDocument, Document } from 'yaml'
import { writeFileSync } from 'fs'

function roundTripEdit(yamlText: string, key: string, newValue: unknown): string {
  const doc: Document = parseDocument(yamlText)

  // Check for parse errors before mutating
  if (doc.errors.length > 0) {
    throw new Error(`YAML parse error: ${doc.errors[0].message}`)
  }

  // Mutate one key — comments on other keys are unaffected
  doc.set(key, newValue)

  // toString() re-emits with original comments preserved
  return doc.toString()
}

const original = `
# Profile: high-quality
# Edit this file and re-run cli-agent to apply changes.

cliParams:
  provider: anthropic   # provider name
  model: claude-opus-4  # model identifier
  temperature: 0.7
`

const updated = roundTripEdit(original, 'cliParams', {
  provider: 'openai',
  model: 'gpt-5',
  temperature: 0.7,
})

// Comments on the document header and unchanged nodes are preserved:
// # Profile: high-quality
// # Edit this file and re-run cli-agent to apply changes.
//
// cliParams:
//   provider: openai
//   model: gpt-5
//   temperature: 0.7
```

**Key observation**: When you use `doc.set('cliParams', newValue)` with a plain object, the
new value is re-serialized without inheriting the original node's comments. If you need to
preserve inline comments *within* a nested map, you must use `doc.getIn(['cliParams'])` to
retrieve the existing `YAMLMap` node and mutate individual keys rather than replacing the
whole subtree.

---

## 4. Error Reporting — Line/Column for Friendly E2 Messages

### `YAMLParseError` fields

Every error and warning object produced by the parser contains:

| Field | Type | Description |
|---|---|---|
| `name` | `'YAMLParseError' \| 'YAMLWarning'` | Discriminates errors from warnings |
| `code` | `string` | Machine-readable error type (e.g. `'BAD_INDENT'`, `'BLOCK_AS_IMPLICIT_KEY'`) |
| `message` | `string` | Human-readable description including the location when `prettyErrors: true` |
| `pos` | `[number, number]` | Byte offsets `[start, end]` in the source string |
| `linePos` | `[LinePos, LinePos] \| undefined` | One-indexed `{ line: number, col: number }` objects for `pos[0]` and `pos[1]` |

`linePos` is populated when `prettyErrors: true` (the default). It is the value to embed in
user-facing error messages.

### Pattern for E2 (malformed YAML) in profile-codec.ts

```ts
import { parseDocument } from 'yaml'
import type { YAMLParseError } from 'yaml'

export class ProfileParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ProfileParseError'
  }
}

export function parseProfileText(text: string): unknown {
  // parseDocument never throws — errors land in doc.errors[]
  const doc = parseDocument(text, {
    prettyErrors: true,   // ensures linePos is populated (default: true)
    logLevel: 'error',    // suppress console.warn for YAML spec warnings
  })

  if (doc.errors.length > 0) {
    const err = doc.errors[0] as YAMLParseError
    const line = err.linePos?.[0]?.line ?? 0
    const col  = err.linePos?.[0]?.col  ?? 0
    throw new ProfileParseError(
      `Malformed YAML in profile file at line ${line}, column ${col}: ${err.message}`,
      line,
      col,
      err.code,
    )
  }

  return doc.toJS()
}
```

This gives the planner the exact "line:col: message" surface needed for the E2 diagnostic
without any try/catch on `parse()`. Because `parseDocument()` never throws, the error path is
entirely explicit.

### Common error codes to handle specially

| Code | Human scenario | Suggested message prefix |
|---|---|---|
| `BAD_INDENT` | User tab-indented their profile | "Indentation error (use spaces, not tabs)" |
| `BLOCK_AS_IMPLICIT_KEY` | `key: sub-key: value` on one line | "Ambiguous mapping — check indentation" |
| `DUPLICATE_KEY` | Same `cliParams.model` key twice | "Duplicate key — each setting must appear once" |
| `MULTIPLE_DOCS` | File has a `---` separator | "Profile file must contain a single YAML document" |
| `RESOURCE_EXHAUSTION` | Deeply nested document | "Profile file is too deeply nested to parse" |

---

## 5. TypeScript Patterns — `parse() → unknown → Zod`

The `parse()` function is typed as returning `any`, which bypasses TypeScript's type system.
The safe pattern is to cast the result to `unknown` immediately and then pass through Zod.

### Pattern A: `parse()` → `unknown` → Zod `.parse()`

```ts
import { parse } from 'yaml'
import { z } from 'zod'
import { ProfileSchema } from './profile-schema'
import type { Profile } from './profile-schema'

export function loadProfileFromText(text: string): Profile {
  // 1. Parse YAML to plain JS (throws YAMLParseError on syntax failure)
  const raw: unknown = parse(text, { logLevel: 'error' })

  // 2. Validate schema (throws ZodError on structural failure)
  return ProfileSchema.parse(raw)
}
```

This is the shortest path and sufficient when you do not need line/col error messages.
`ZodError` will indicate which key failed but will not give YAML line numbers.

### Pattern B: `parseDocument()` → `.toJS()` → `unknown` → Zod `.safeParse()`

This is the recommended pattern for profile-codec.ts because it gives both YAML line numbers
and Zod structural errors in a single unified error type.

```ts
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { ProfileSchema } from './profile-schema'
import type { Profile } from './profile-schema'
import { ConfigurationError } from '../errors'

export function parseProfile(text: string, filePath: string): Profile {
  // Step 1: YAML parse — collect structural errors without throwing
  const doc = parseDocument(text, { prettyErrors: true, logLevel: 'error' })

  if (doc.errors.length > 0) {
    const err = doc.errors[0]
    const loc = err.linePos?.[0]
    const location = loc ? ` (line ${loc.line}, col ${loc.col})` : ''
    throw new ConfigurationError(
      `Profile file has a YAML syntax error${location}: ${err.message}\n` +
      `File: ${filePath}`
    )
  }

  // Step 2: Convert to plain JS — this is now safe because errors[] was empty
  const raw: unknown = doc.toJS()

  // Step 3: Zod schema validation
  const result = ProfileSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new ConfigurationError(
      `Profile file failed schema validation:\n${issues}\nFile: ${filePath}`
    )
  }

  return result.data
}
```

### Inferred types from the Zod schema

```ts
// src/config/profile-schema.ts
import { z } from 'zod'

export const ProfileSchema = z.object({
  schemaVersion: z.literal(1),
  cliParams: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    // ... other known CLI params
  }).passthrough().optional(),  // passthrough for forward-compat (E20)
  tools: z.object({
    allow: z.array(z.string()).min(1).optional(),
    deny:  z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
  }).optional(),
  toolArgs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).strict()  // .strict() rejects unknown top-level keys (E3)

export type Profile = z.infer<typeof ProfileSchema>
```

The `.strict()` at the top level and `.passthrough()` on `cliParams` align with the investigation
document's Q6 recommendation: hard-reject unknown top-level keys, but forward-tolerate unknown
`cliParams` with a warning.

---

## 6. Anchor/Alias Handling — Practical Attack Surface

### What aliases do in the yaml package

When the parser encounters an alias node (`*anchorName`), it stores a reference to the anchored
node in the AST. At `.toJS()` time it resolves all aliases by copying the anchored value and
incrementing a reference counter. When the counter hits `maxAliasCount` (default: 100) a
`ReferenceError` is thrown.

### Checking for alias presence before `.toJS()`

If you want to reject any file that uses anchors or aliases entirely (zero tolerance for
even legitimate YAML anchors), you can inspect the document before calling `.toJS()`:

```ts
import { parseDocument, visit, isAlias } from 'yaml'

export function parseProfileStrict(text: string): unknown {
  const doc = parseDocument(text, { prettyErrors: true, logLevel: 'error' })

  if (doc.errors.length > 0) {
    // ... same error handling as above
  }

  // Reject any alias node in the document tree
  visit(doc, {
    Alias(_key, node) {
      throw new ConfigurationError(
        `Profile file contains a YAML alias (*${node.source}). ` +
        `Aliases are not permitted in profile files.`
      )
    },
  })

  return doc.toJS({ maxAliasCount: 0 })
}
```

### Should profile-codec.ts reject aliases?

This is a policy decision. Two reasonable positions:

**Position A — reject all aliases (strictest)**
Profile files are small and hand-written. There is no legitimate need for YAML anchors in a
profile file. Rejecting them gives the clearest possible error message ("aliases not allowed")
and eliminates even theoretical DoS from a malformed file. This is the recommendation for
profile-codec.ts.

**Position B — allow aliases with low limit**
Allow up to 5 aliases to support legitimate YAML anchor patterns (e.g., a user DRY-ing their
model name). Pass `maxAliasCount: 5` to `.toJS()`. This is acceptable for a local file; the
default 100 is already safe, and 5 removes any question of intentional abuse.

Given that the investigation document's threat model is "local user-authored file, not network
input," both positions are acceptable. Position A is recommended because it simplifies
documentation (the feature advertises no anchor support) and eliminates a class of confusing
error messages ("Why did my anchor not expand?").

---

## 7. Comparison to `js-yaml`

`js-yaml` v4.x and `yaml` (eemeli) v2.x are both zero-dependency, YAML 1.2 compliant libraries
of similar size. The decision to use `yaml` for this project is already made; this section
records the technical tradeoffs for completeness.

**TypeScript types**: `yaml` ships bundled first-party types. `js-yaml` requires the separate
`@types/js-yaml` package, which was last updated in 2022 and does not reflect the v4 API
accurately — the investigation document cites this as a key differentiator.

**Comment/round-trip support**: `yaml` has explicit first-class support for comments via the
Document API (`commentBefore`, `comment`, `spaceBefore` on every node). `js-yaml` has no
comment-preservation capability; comments are discarded on parse. This makes `yaml` the only
viable choice for the profile-edit round-trip requirement.

**Error surface**: `yaml`'s `parseDocument()` accumulates errors without throwing; `js-yaml`'s
`load()` throws a `YAMLException` that includes a snippet and mark object, but only on the
first error. For structured diagnostics (collecting all errors, accessing `linePos` as typed
fields) the `yaml` API is richer.

**Security defaults**: Both libraries resolve only safe YAML types by default. `js-yaml` v4
removed the unsafe `safeLoad`/`safeLoadAll` naming confusion (the "safe" functions are now
just `load`/`loadAll`), and the DEFAULT_SCHEMA resolves timestamps and binary — identical to
`yaml`'s `resolveKnownTags: true` default. The `maxAliasCount` guard exists only in `yaml`;
`js-yaml` has no equivalent explicit alias-count cap, though in practice unlimited aliases
would exhaust the JS call stack before reaching a billion-laughs level.

**API ergonomics for this project**: `yaml`'s `parse()` → `unknown` → Zod pattern is identical
in shape to what `js-yaml` would provide. The deciding factor in favor of `yaml` is the Document
API for comment preservation plus bundled TS types.

---

## Usage Examples — Complete Profile Codec Skeleton

The following is a complete skeleton for `src/config/profile-codec.ts` that the implementer
can use directly.

```ts
// src/config/profile-codec.ts
//
// Encapsulates all yaml-package interaction for profile files.
// Callers see only parseProfile() and stringifyProfile() — the yaml
// dependency is contained entirely within this module.

import { parseDocument, stringify } from 'yaml'
import { isAlias, visit } from 'yaml'
import type { Document } from 'yaml'
import { z } from 'zod'
import { ProfileSchema } from './profile-schema'
import type { Profile } from './profile-schema'
import { ConfigurationError } from '../errors'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse a raw YAML string, throw ConfigurationError on any syntax problem. */
function parseYamlSafely(text: string, filePath: string): Document {
  const doc = parseDocument(text, {
    prettyErrors: true,  // populate linePos on errors (default true, stated explicitly)
    logLevel: 'error',   // suppress YAML spec warnings from console.warn
  })

  if (doc.errors.length > 0) {
    const err = doc.errors[0]
    const loc = err.linePos?.[0]
    const location = loc ? ` at line ${loc.line}, column ${loc.col}` : ''
    throw new ConfigurationError(
      `Profile file has a YAML syntax error${location}: ${err.message}\nFile: ${filePath}`
    )
  }

  return doc
}

/** Reject any document that contains alias nodes. */
function rejectAliases(doc: Document, filePath: string): void {
  visit(doc, {
    Alias(_key, node) {
      throw new ConfigurationError(
        `Profile file contains a YAML alias (*${node.source}), which is not ` +
        `supported in profile files.\nFile: ${filePath}`
      )
    },
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a profile file's text content into a validated Profile object.
 *
 * Throws ConfigurationError (never ZodError, never YAMLParseError) so callers
 * always receive a single error type regardless of whether the failure is a
 * YAML syntax issue or a schema violation.
 *
 * @param text    - Raw UTF-8 text of the profile file
 * @param filePath - Path used only for error messages
 */
export function parseProfile(text: string, filePath: string): Profile {
  const doc = parseYamlSafely(text, filePath)
  rejectAliases(doc, filePath)

  const raw: unknown = doc.toJS()

  const result = ProfileSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n')
    throw new ConfigurationError(
      `Profile file failed schema validation:\n${issues}\nFile: ${filePath}`
    )
  }

  return result.data
}

/**
 * Serialize a validated Profile object back to YAML text.
 *
 * Used by profile-create (writes a new stub file) and
 * profile-create --from-current (serializes the current effective config).
 * Does NOT attempt to preserve comments from any previously-read file;
 * to preserve comments use the Document API directly.
 */
export function stringifyProfile(profile: Profile): string {
  return stringify(profile, {
    indent: 2,
    lineWidth: 100,
    singleQuote: false,
  })
}

/**
 * Write a new profile stub with explanatory comments.
 *
 * Returns the YAML text; the caller is responsible for writing to disk.
 */
export function createProfileStub(name: string): string {
  return [
    `# cli-agent profile: ${name}`,
    `# Generated by profile-create. Edit this file, then run:`,
    `#   cli-agent --profile ${name} [your query]`,
    `#`,
    `# See docs/design/configuration-guide.md for all available settings.`,
    ``,
    `schemaVersion: 1`,
    ``,
    `# --- cliParams ----------------------------------------------------------`,
    `# Uncomment and edit any of the following to pin CLI parameter values.`,
    `#`,
    `# cliParams:`,
    `#   provider: anthropic`,
    `#   model: claude-opus-4`,
    `#   temperature: 0.7`,
    `#   maxIterations: 50`,
    ``,
    `# --- tools ---------------------------------------------------------------`,
    `# Uncomment to restrict which tools the agent may use.`,
    `#`,
    `# tools:`,
    `#   allow:`,
    `#     - bash_run`,
    `#     - file_read`,
    `#   deny: []`,
    `#   order: []`,
    ``,
    `# --- toolArgs ------------------------------------------------------------`,
    `# Uncomment to set default arguments for specific tools.`,
    `#`,
    `# toolArgs:`,
    `#   web_search:`,
    `#     maxResults: 10`,
    ``,
  ].join('\n')
}
```

---

## Best Practices

1. **Always use `parseDocument()` in profile-codec.ts**, not `parse()`. The "never throws"
   guarantee lets you inspect `doc.errors[]` and produce a `ConfigurationError` with line/col
   information before Zod ever sees the data. If you use `parse()` you must wrap it in
   `try/catch` and the `YAMLParseError` type is harder to differentiate from other errors.

2. **Cast the result of `.toJS()` to `unknown`, never `any`**. TypeScript will then require
   a Zod validation step before the type is narrowed to `Profile`. This prevents accidentally
   using an unvalidated object.

3. **Set `logLevel: 'error'`** to suppress `console.warn` calls from the yaml package. Profile
   loading is a server-side initialization step; unexpected console output during startup is
   confusing and will pollute test output.

4. **Do not re-stringify after a user edit**. After `$EDITOR` returns, call `parseProfile()` for
   validation only. Do not call `stringifyProfile()` and write back to disk — this would silently
   normalize the user's formatting and erase any formatting choices they made in the editor.

5. **Use `.strict()` on the Zod schema at the top level**. The `yaml` package's `parse()` does
   not strip unknown keys; only Zod `.strict()` will reject them. If you do not use `.strict()`,
   a misspelled top-level key (e.g. `cliparams` instead of `cliParams`) will be silently ignored.

6. **Pass `{ merge: false }` explicitly** (it is already the default for schema 1.2) to make
   the "no merge keys supported" policy visible in the code rather than relying on a default.

---

## Common Pitfalls

### Pitfall 1: `parse()` silently accepting a multi-document file

If the profile file contains a YAML stream (`---` separator), `parse()` includes an error in
the document and then **throws it**. Using `parseDocument()` puts this error in `doc.errors[0]`
where your handler can produce the E2 message with the code `MULTIPLE_DOCS`.

### Pitfall 2: Comment drift when mutating nested nodes

If you replace an entire nested mapping (e.g., `doc.set('cliParams', newObject)`), any inline
comments on the previous `cliParams` sub-keys are lost. To preserve them you must retrieve
the existing `YAMLMap` node and update individual keys:

```ts
// Preserves existing comments on sub-keys
const existing = doc.get('cliParams')
if (existing && typeof existing === 'object') {
  doc.setIn(['cliParams', 'model'], 'gpt-5')
} else {
  doc.set('cliParams', { model: 'gpt-5' })
}
```

### Pitfall 3: `toJS()` coercing YAML dates to JavaScript `Date` objects

The `resolveKnownTags: true` default means a value like `2025-01-01` in a profile file is
parsed as a JavaScript `Date`, not a string. Zod's `z.string()` will reject this. If any
profile field could look like a date, use `z.preprocess(v => String(v), z.string())` in the
schema, or pass `customTags: []` and `resolveKnownTags: false` to the parse call to disable
all tag resolution beyond core primitives.

```ts
// Strictest possible tag resolution — only JSON-compatible values
const doc = parseDocument(text, {
  prettyErrors: true,
  logLevel: 'error',
  resolveKnownTags: false,
})
```

### Pitfall 4: `schema: 'failsafe'` treating numbers as strings

If you ever use `schema: 'failsafe'` for maximum safety, be aware that all scalars become
strings — `temperature: 0.7` would parse to the string `"0.7"`, breaking `z.number()` in the
Zod schema. The default `'core'` schema is the right balance: resolves numbers, booleans, and
nulls correctly, rejects arbitrary type tags.

### Pitfall 5: Ignoring `doc.warnings[]`

The yaml package populates `doc.warnings[]` for YAML spec-mandated warnings (e.g., using a
deprecated construct). These do not prevent parsing but may indicate a user has written
something that will be removed in a future YAML version. Logging them at `debug` level during
profile load is a good practice.

---

## Advanced Topics

### Using the `visit()` API for profile schema introspection

The `visit()` function walks every node in the AST and lets you run callbacks per node type.
Beyond alias rejection (shown above), it can be used to scan for explicitly-tagged nodes:

```ts
import { visit, isScalar } from 'yaml'

// Warn if the profile uses any explicit YAML tags (e.g. !!str, !!int)
visit(doc, {
  Scalar(_key, node) {
    if (node.tag) {
      // Explicit tag like !!str or !!timestamp found
      console.warn(`Profile uses explicit YAML tag '${node.tag}'; ignoring tag and using value as-is`)
    }
  },
})
```

### `LineCounter` for custom streaming pipelines

If profile-codec.ts ever needs to integrate with a streaming parser (e.g., parsing a profile
from stdin incrementally), the low-level `LineCounter` API can track newlines independently
of the high-level Document API:

```ts
import { LineCounter, Parser } from 'yaml'

const lc = new LineCounter()
const parser = new Parser(lc.addNewLine)
for (const token of parser.parse(text)) {
  // process tokens; use lc.linePos(offset) for location lookups
}
```

For profile-codec.ts this is overkill — profiles are small, fully-buffered files.

---

## Assumptions and Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| The profile-codec.ts only needs to handle single-document YAML files | HIGH | If multi-document files become a requirement, `parseAllDocuments()` replaces `parseDocument()` |
| Profile files are <= 32 KB | HIGH | `maxAliasCount` and `RESOURCE_EXHAUSTION` limits are calibrated for small files; large files would need lower limits |
| Aliases are not needed in profile files | MEDIUM | If anchors are desired (e.g. DRY config), change the `rejectAliases` call to `maxAliasCount: 5` |
| The `resolveKnownTags: true` default is acceptable | MEDIUM | If any profile value could be a YAML date string, set `resolveKnownTags: false` |
| TypeScript version is >= 3.9 (the yaml package minimum) | HIGH | The project is on Node 22+ so this is almost certainly satisfied |

### What is Explicitly Out of Scope

- YAML 1.1 compatibility (`version: '1.1'` option) — profiles are always written by cli-agent
  itself and will conform to YAML 1.2
- Streaming parse of large YAML files — profiles are small, fully-buffered
- Multi-document YAML streams — not applicable to profile files
- Custom tag handlers — profiles contain only primitive data
- The `js-yaml` migration path — the decision is final, no migration code needed

### Uncertainties and Gaps

- **Trailing comment stability**: The official docs note that trailing comments "may be
  associated with different nodes upon re-parsing." The practical impact on profile round-trips
  has not been bench-tested. The recommended mitigation (do not re-stringify after user edit)
  avoids the issue entirely.
- **`resolveKnownTags` interaction with Zod**: Not explicitly tested in this research. The
  `z.preprocess` workaround in Pitfall 3 is the defensive approach.
- **yaml v2 latest patch version**: The research used the current documentation at eemeli.org/yaml/
  which corresponds to yaml v2.x. The exact latest patch (e.g. 2.7.x) was not verified; use
  `"yaml": "^2.x"` as the investigation document recommends and rely on semver.

---

## Clarifying Questions for Follow-up

1. Should `profile-create --from-current` preserve the original stub comments when the user
   has already edited the file, or always generate a clean YAML from the validated Profile
   object? (This determines whether `stringifyProfile()` or a Document-API round-trip is used.)

2. Should `profile-edit` re-validate (parse only) or re-validate AND re-format (parse then
   re-stringify)? Re-formatting would give consistent indentation at the cost of erasing the
   user's style choices and triggering the trailing-comment drift risk.

3. Is there a requirement to surface all Zod validation errors at once (not just the first),
   or is a single error per load acceptable? The current skeleton reports all Zod issues in
   one `ConfigurationError` message — confirm this is the desired UX.

4. Does the `cliParams.passthrough()` on the Zod schema need to emit a per-key warning for
   unrecognized keys (E20), or is a single summary warning ("N unrecognized cliParams keys")
   sufficient?

---

## References

| # | Source | URL | Information Gathered |
|---|---|---|---|
| 1 | eemeli/yaml official docs | https://eemeli.org/yaml/ | Full API reference: parse(), parseDocument(), options tables (ParseOptions, ToJSOptions, SchemaOptions, ToStringOptions), Document methods, comment handling, error fields |
| 2 | eemeli/yaml errors reference | https://github.com/eemeli/yaml/blob/main/docs/08_errors.md | Complete error code table (ALIAS_PROPS through UNEXPECTED_TOKEN), YAMLParseError field definitions, silencing options |
| 3 | eemeli/yaml content nodes reference | https://github.com/eemeli/yaml/blob/main/docs/05_content_nodes.md | NodeBase interface, Scalar/YAMLMap/YAMLSeq class shapes, comment/commentBefore/spaceBefore fields, visit() API |
| 4 | eemeli/yaml — Context7 snapshot | https://context7.com/eemeli/yaml/llms.txt | Code examples: parseDocument usage, error array inspection, round-trip stringify, comment access, ToJS options including maxAliasCount |
| 5 | eemeli/yaml parsing docs | https://github.com/eemeli/yaml/blob/main/docs/04_documents.md | parseDocument/parseAllDocuments API, "never throws" guarantee, AST structure example |
| 6 | js-yaml README | https://github.com/nodeca/js-yaml/blob/master/README.md | Built-in schema list (FAILSAFE, JSON, CORE, DEFAULT), load() error behavior — comparison baseline |
| 7 | js-yaml v3→v4 migration | https://github.com/nodeca/js-yaml/blob/master/migrate_v3_to_v4.md | Confirmation that safeLoad was renamed to load in v4; default is now safe |
| 8 | investigation-config-profiles.md | local: docs/reference/investigation-config-profiles.md | Context for all seven research questions; Q1/Q6 package decision rationale; profile-codec.ts module spec |
