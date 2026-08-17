// McpArgValidator — runtime argument validation against a tool's inputSchema.
//
// strictSchema rewrites schemas for the LLM; this validator checks the arguments
// that actually ARRIVE, before they are forwarded to the MCP server. The
// contract: a malformed call fails locally with a readable reason instead of a
// cryptic server-side parse error.

import { describe, it, expect } from 'vitest';
import { validateMcpArgs } from '../McpArgValidator.js';

const schema = (props, required = [], extra = {}) => ({
  type: 'object',
  properties: props,
  required,
  ...extra,
});

describe('validateMcpArgs', () => {
  it('accepts a well-typed call', () => {
    const r = validateMcpArgs(
      { path: 'C:/a.txt', lines: 5, flag: true },
      schema(
        {
          path: { type: 'string' },
          lines: { type: 'integer' },
          flag: { type: 'boolean' },
        },
        ['path'],
      ),
    );
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('reports a missing required field', () => {
    const r = validateMcpArgs(
      {},
      schema({ query: { type: 'string' } }, ['query']),
    );
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(['"query" is required but missing']);
  });

  it('rejects a wrong type with a readable message', () => {
    const r = validateMcpArgs(
      { limit: 'ten' },
      schema({ limit: { type: 'integer' } }, ['limit']),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('"limit" must be integer, got string');
  });

  it('accepts null for a nullable union type', () => {
    const r = validateMcpArgs(
      { note: null },
      schema({ note: { type: ['string', 'null'] } }, ['note']),
    );
    expect(r.valid).toBe(true);
  });

  it('honors enum constraints', () => {
    const r = validateMcpArgs(
      { role: 'reader' },
      schema({ role: { type: 'string', enum: ['researcher', 'reviewer'] } }, ['role']),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('must be one of');
  });

  it('rejects unknown keys when additionalProperties is false', () => {
    const r = validateMcpArgs(
      { known: 1, stray: 2 },
      schema({ known: { type: 'integer' } }, ['known'], { additionalProperties: false }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('unknown property "stray"');
  });

  it('allows extra keys when additionalProperties is absent', () => {
    const r = validateMcpArgs(
      { known: 1, stray: 2 },
      schema({ known: { type: 'integer' } }, ['known']),
    );
    expect(r.valid).toBe(true);
  });

  it('recurses into nested objects and reports the full path', () => {
    const r = validateMcpArgs(
      { rows: { id: 'x', count: 'oops' } },
      schema({
        rows: {
          type: 'object',
          properties: { id: { type: 'string' }, count: { type: 'integer' } },
          required: ['id', 'count'],
        },
      }, ['rows']),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('"rows.count" must be integer');
  });

  it('recurses into arrays with indexed paths', () => {
    const r = validateMcpArgs(
      { tags: ['ok', 7] },
      schema({ tags: { type: 'array', items: { type: 'string' } } }, ['tags']),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('"tags[1]" must be string');
  });

  it('accepts an empty array against an items schema', () => {
    const r = validateMcpArgs(
      { tags: [] },
      schema({ tags: { type: 'array', items: { type: 'string' } } }, ['tags']),
    );
    expect(r.valid).toBe(true);
  });

  it('anyOf passes when at least one branch matches', () => {
    const r = validateMcpArgs(
      { value: 42 },
      schema(
        {
          value: {
            anyOf: [
              { type: 'string', enum: ['auto'] },
              { type: 'integer', minimum: 0 },
            ],
          },
        },
        ['value'],
      ),
    );
    expect(r.valid).toBe(true);
  });

  it('anyOf fails only when every branch fails', () => {
    // An object matches neither the string nor the integer branch.
    const r = validateMcpArgs(
      { value: { nested: true } },
      schema(
        {
          value: {
            anyOf: [
              { type: 'string', enum: ['auto'] },
              { type: 'integer', minimum: 0 },
            ],
          },
        },
        ['value'],
      ),
    );
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain('does not match any of the allowed shapes');
  });

  it('skips unsupported constraint keywords instead of failing', () => {
    // minimum/maxLength are not enforced — the validator only checks the
    // keywords it understands (type/enum/required/properties/items/anyOf).
    const r = validateMcpArgs(
      { n: 3 },
      schema({ n: { type: 'integer', minimum: 10 } }, ['n']),
    );
    expect(r.valid).toBe(true);
  });

  it('treats a missing or non-object schema as unconstrained', () => {
    expect(validateMcpArgs({ a: 1 }, undefined).valid).toBe(true);
    expect(validateMcpArgs({ a: 1 }, null).valid).toBe(true);
    expect(validateMcpArgs({ a: 1 }, 'not a schema').valid).toBe(true);
  });

  it('tolerates missing args entirely', () => {
    const r = validateMcpArgs(undefined, schema({ x: { type: 'string' } }, ['x']));
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(['"x" is required but missing']);
  });

  it('is empty-call-safe when the schema requires nothing', () => {
    const r = validateMcpArgs({}, schema({}));
    expect(r.valid).toBe(true);
  });
});

describe('strict-mode nulls (optional properties)', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      opts: { type: 'object', properties: { deep: { type: 'string' } } },
    },
    required: ['query'],
  };

  it('accepts null for an optional property (the model was told to send it)', () => {
    const r = validateMcpArgs({ query: 'x', limit: null }, schema);
    expect(r.valid).toBe(true);
  });

  it('accepts a nested null on an optional property', () => {
    const r = validateMcpArgs({ query: 'x', opts: { deep: null } }, schema);
    expect(r.valid).toBe(true);
  });

  it('still rejects null on a REQUIRED property', () => {
    const r = validateMcpArgs({ query: null }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('must be string');
  });

  it('still rejects a wrong non-null type', () => {
    expect(validateMcpArgs({ query: 'x', limit: 'ten' }, schema).valid).toBe(false);
  });
});
