import { describe, it, expect } from 'vitest';
import { toStrictSchema } from '../strictSchema.js';

describe('toStrictSchema', () => {
  it('marks every property required and forbids extras', () => {
    const { schema, eligible } = toStrictSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'integer' },
      },
      required: ['a'],
    });
    expect(eligible).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(['a', 'b']);
  });

  it('makes originally-optional properties nullable', () => {
    const { schema } = toStrictSchema({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'integer' },
      },
      required: ['a'],
    });
    // a stays a plain string; b (optional) becomes nullable union
    expect(schema.properties.a.type).toBe('string');
    expect(schema.properties.b.type).toEqual(['integer', 'null']);
  });

  it('recurses into array items and nested objects', () => {
    const { schema, eligible } = toStrictSchema({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, note: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      required: ['rows'],
    });
    expect(eligible).toBe(true);
    const item = schema.properties.rows.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required.sort()).toEqual(['id', 'note']);
    expect(item.properties.note.type).toEqual(['string', 'null']);
  });

  it('strips unsupported constraint keywords', () => {
    const { schema } = toStrictSchema({
      type: 'object',
      properties: {
        n: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
        s: { type: 'string', minLength: 1, format: 'email' },
      },
      required: ['n', 's'],
    });
    expect(schema.properties.n.minimum).toBeUndefined();
    expect(schema.properties.n.default).toBeUndefined();
    expect(schema.properties.s.minLength).toBeUndefined();
    expect(schema.properties.s.format).toBeUndefined();
  });

  it('rejects open-ended objects (no properties)', () => {
    const { eligible } = toStrictSchema({
      type: 'object',
      properties: { headers: { type: 'object', description: 'arbitrary map' } },
      required: ['headers'],
    });
    expect(eligible).toBe(false);
  });

  it('rejects $ref / oneOf / allOf', () => {
    expect(toStrictSchema({ type: 'object', properties: { x: { $ref: '#/$defs/Y' } }, required: ['x'] }).eligible).toBe(false);
    expect(toStrictSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }).eligible).toBe(false);
  });

  it('returns the original schema unchanged when ineligible', () => {
    const original = { type: 'object', properties: { m: { type: 'object' } }, required: ['m'] };
    const { schema, eligible } = toStrictSchema(original);
    expect(eligible).toBe(false);
    expect(schema).toBe(original);
  });

  it('preserves enum values', () => {
    const { schema } = toStrictSchema({
      type: 'object',
      properties: { action: { type: 'string', enum: ['set', 'get'] } },
      required: ['action'],
    });
    expect(schema.properties.action.enum).toEqual(['set', 'get']);
  });
});
