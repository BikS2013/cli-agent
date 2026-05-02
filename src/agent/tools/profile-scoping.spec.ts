/**
 * Unit tests for applyProfileToolScoping (src/agent/tools/profile-scoping.ts).
 *
 * Coverage matrix (plan-005 §5 U-SCOPE acceptance criteria):
 *   - AC-7  allow filters in
 *   - AC-8  deny filters out
 *   - AC-9  order reorders
 *   - AC-10 combined allow + deny + order applies in correct sequence
 *   - E7    empty survivors → ConfigurationError exit 3
 *   - E8    unknown name in allow → warning (non-fatal)
 *   - E8    unknown name in deny → warning (non-fatal)
 *   - E21   order references non-survivor → warning (non-fatal)
 *   - E22   duplicate in order → ConfigurationError exit 3
 *   - E23   allow ∩ deny non-empty → ConfigurationError exit 3
 *   - Stable reorder: survivors not in order keep relative position
 *   - Identity: undefined / all-undefined-keys scoping → no warnings, no
 *     mutation
 */

import { describe, it, expect } from 'vitest';
import { applyProfileToolScoping } from './profile-scoping.js';

// Lightweight fake tool — only the `.name` property is consulted by the
// scoping algorithm.
function fakeTool(name: string): { name: string } {
  return { name };
}

function makeCatalog(): { name: string }[] {
  return [
    fakeTool('file_read'),
    fakeTool('file_list'),
    fakeTool('bash_run'),
    fakeTool('web_search'),
    fakeTool('tool_help'),
  ];
}

describe('applyProfileToolScoping — identity', () => {
  it('returns input unchanged when scoping is undefined', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, undefined);
    expect(result.warnings).toEqual([]);
    expect(result.tools).toBe(tools);
  });

  it('returns input unchanged when all three keys are undefined', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {});
    expect(result.warnings).toEqual([]);
    expect(result.tools).toBe(tools);
  });
});

describe('applyProfileToolScoping — AC-7 allow', () => {
  it('keeps only tools whose name is in allow', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      allow: ['file_read', 'bash_run'],
    });
    expect(result.tools.map((t) => t.name)).toEqual(['file_read', 'bash_run']);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyProfileToolScoping — AC-8 deny', () => {
  it('removes tools whose name is in deny', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      deny: ['bash_run', 'web_search'],
    });
    expect(result.tools.map((t) => t.name)).toEqual([
      'file_read',
      'file_list',
      'tool_help',
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyProfileToolScoping — AC-9 order', () => {
  it('reorders so that order-listed tools come first in order, others appended', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      order: ['web_search', 'file_read'],
    });
    // 'web_search' first, then 'file_read', then the rest in original order.
    expect(result.tools.map((t) => t.name)).toEqual([
      'web_search',
      'file_read',
      'file_list',
      'bash_run',
      'tool_help',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('stability: survivors not mentioned in order keep relative order', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      order: ['tool_help'],
    });
    expect(result.tools.map((t) => t.name)).toEqual([
      'tool_help',
      'file_read',
      'file_list',
      'bash_run',
      'web_search',
    ]);
  });
});

describe('applyProfileToolScoping — AC-10 combined allow + deny + order', () => {
  it('applies allow → deny → order in that exact sequence', () => {
    // allow=[file_read, file_list, bash_run, web_search], deny=[tool_help] would
    // not intersect; instead we test the combined pipeline by allowing four
    // tools and denying a fifth that is NOT in allow (but IS in catalog) — the
    // deny effectively no-ops since the allow filter already removed it. The
    // reorder then applies to survivors.
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      allow: ['file_read', 'file_list', 'bash_run', 'web_search'],
      deny: ['tool_help'],
      order: ['web_search', 'file_list'],
    });
    // After allow: [file_read, file_list, bash_run, web_search]
    // After deny:  [file_read, file_list, bash_run, web_search]   (tool_help already gone)
    // After order: [web_search, file_list, file_read, bash_run]
    expect(result.tools.map((t) => t.name)).toEqual([
      'web_search',
      'file_list',
      'file_read',
      'bash_run',
    ]);
    expect(result.warnings).toEqual([]);
  });
});

describe('applyProfileToolScoping — hard errors', () => {
  it('E22: duplicate name in order → ConfigurationError', () => {
    const tools = makeCatalog();
    try {
      applyProfileToolScoping(tools, {
        order: ['file_read', 'bash_run', 'file_read'],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
      const details = (e as { details: Record<string, unknown> }).details;
      expect(String(details['detail'])).toMatch(/duplicate/);
      expect(details['duplicates']).toEqual(['file_read']);
    }
  });

  it('E23: allow ∩ deny non-empty → ConfigurationError', () => {
    const tools = makeCatalog();
    try {
      applyProfileToolScoping(tools, {
        allow: ['file_read', 'bash_run'],
        deny: ['bash_run'],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
      const details = (e as { details: Record<string, unknown> }).details;
      expect(String(details['detail'])).toMatch(/allow.*deny|share/i);
      expect(details['intersection']).toEqual(['bash_run']);
    }
  });

  it('E7: deny removes every catalog tool → ConfigurationError', () => {
    const tools = makeCatalog();
    try {
      applyProfileToolScoping(tools, {
        deny: ['file_read', 'file_list', 'bash_run', 'web_search', 'tool_help'],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
      const details = (e as { details: Record<string, unknown> }).details;
      expect(String(details['detail'])).toMatch(/disabled every tool|relax/i);
    }
  });

  it('E7: allow lists only unknown names → ConfigurationError', () => {
    const tools = makeCatalog();
    try {
      applyProfileToolScoping(tools, {
        allow: ['nonexistent_tool'],
      });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});

describe('applyProfileToolScoping — non-fatal warnings', () => {
  it('E8: unknown name in allow → warning, not error', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      allow: ['file_read', 'no_such_tool'],
    });
    expect(result.tools.map((t) => t.name)).toEqual(['file_read']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/allowlist.*'no_such_tool'/);
  });

  it('E8: unknown name in deny → warning, not error', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      deny: ['no_such_tool'],
    });
    // Catalog passes through unchanged (unknown deny name has no effect).
    expect(result.tools.map((t) => t.name)).toEqual([
      'file_read',
      'file_list',
      'bash_run',
      'web_search',
      'tool_help',
    ]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/denylist.*'no_such_tool'/);
  });

  it('E21: order references non-survivor → warning, not error', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      allow: ['file_read', 'bash_run'],
      order: ['bash_run', 'web_search'], // web_search excluded by allow
    });
    expect(result.tools.map((t) => t.name)).toEqual(['bash_run', 'file_read']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/order.*'web_search'.*excluded/);
  });

  it('E21: order references tool that was denied → warning', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      deny: ['web_search'],
      order: ['web_search', 'file_read'],
    });
    expect(result.tools.map((t) => t.name)).toEqual([
      'file_read',
      'file_list',
      'bash_run',
      'tool_help',
    ]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/order.*'web_search'.*excluded/);
  });

  it('multiple unknown names in allow + deny accumulate warnings', () => {
    const tools = makeCatalog();
    const result = applyProfileToolScoping(tools, {
      allow: ['file_read', 'ghost_a'],
      deny: ['ghost_b'],
    });
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.some((w) => /allowlist.*'ghost_a'/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /denylist.*'ghost_b'/.test(w))).toBe(true);
  });
});
