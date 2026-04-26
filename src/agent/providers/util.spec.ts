import { describe, it, expect } from 'vitest';
import { normalizeFoundryEndpoint, normalizeOllamaBaseUrl } from './util.js';

describe('normalizeFoundryEndpoint', () => {
  it('appends /anthropic to bare endpoint', () => {
    expect(normalizeFoundryEndpoint('https://my.azure.com')).toBe('https://my.azure.com/anthropic');
  });

  it('strips trailing slash before appending', () => {
    expect(normalizeFoundryEndpoint('https://my.azure.com/')).toBe('https://my.azure.com/anthropic');
  });

  it('strips /models suffix', () => {
    expect(normalizeFoundryEndpoint('https://my.azure.com/models')).toBe('https://my.azure.com/anthropic');
  });

  it('handles /Models (case-insensitive)', () => {
    expect(normalizeFoundryEndpoint('https://my.azure.com/Models')).toBe('https://my.azure.com/anthropic');
  });

  it('handles trailing whitespace', () => {
    expect(normalizeFoundryEndpoint('  https://my.azure.com  ')).toBe('https://my.azure.com/anthropic');
  });
});

describe('normalizeOllamaBaseUrl', () => {
  it('appends /v1 to plain host', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
  });

  it('does not double-append /v1', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });

  it('strips trailing slash before appending', () => {
    expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
  });
});
