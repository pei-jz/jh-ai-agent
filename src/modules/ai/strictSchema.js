/**
 * Strict JSON-Schema conversion for OpenAI "Structured Outputs" (strict tool
 * calling). Built-in tool schemas are authored strict-compliant by hand; this
 * module is mainly for THIRD-PARTY MCP tool schemas, which we cannot control:
 * we convert the ones that CAN be made compliant and leave the rest as-is
 * (sent without strict).
 *
 * OpenAI strict mode requires, at every object level:
 *   • additionalProperties: false
 *   • EVERY property listed in `required` (optionality is expressed by making a
 *     property nullable, i.e. union its type with "null")
 * and only supports a limited keyword set. Unsupported keywords (numeric/string
 * constraints, defaults, formats, …) must be removed.
 *
 * We deliberately REFUSE (return eligible:false) on structures we can't safely
 * rewrite — open-ended objects (a `type:"object"` with no `properties`), and
 * the combinators/refs that strict either forbids or that we don't want to
 * resolve. Those tools still work, just without strict.
 */

// JSON-Schema keywords OpenAI strict mode accepts. Anything else is stripped.
const SUPPORTED_KEYWORDS = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'anyOf', 'title',
]);

// Constructs we will not attempt to rewrite — presence ⇒ ineligible.
const UNSUPPORTED_KEYWORDS = new Set([
  '$ref', '$defs', 'definitions', 'oneOf', 'allOf', 'not', 'patternProperties',
  'dependencies', 'dependentSchemas', 'if', 'then', 'else',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively convert `node` to a strict-compliant schema in place on a clone.
 * Throws a sentinel Error when the node cannot be made compliant.
 */
function convertNode(node) {
  if (!isPlainObject(node)) {
    throw new Error('INELIGIBLE: non-object schema node');
  }
  for (const k of Object.keys(node)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) {
      throw new Error(`INELIGIBLE: unsupported keyword "${k}"`);
    }
  }

  // Strip keywords strict doesn't accept (constraints, defaults, formats, …).
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (SUPPORTED_KEYWORDS.has(k)) out[k] = v;
    // else: silently dropped (e.g. minLength, default, format, examples)
  }

  // Normalize the declared type. `type` may be a string or an array.
  const types = out.type === undefined
    ? []
    : (Array.isArray(out.type) ? out.type.slice() : [out.type]);
  const isObjectType = types.includes('object');
  const isArrayType = types.includes('array');

  // anyOf: recurse into each branch.
  if (out.anyOf) {
    if (!Array.isArray(out.anyOf) || out.anyOf.length === 0) {
      throw new Error('INELIGIBLE: empty anyOf');
    }
    out.anyOf = out.anyOf.map(convertNode);
  }

  if (isObjectType) {
    const props = out.properties;
    if (!isPlainObject(props) || Object.keys(props).length === 0) {
      // Open-ended map (no enumerable keys) — cannot express in strict mode.
      throw new Error('INELIGIBLE: object without properties');
    }
    const newProps = {};
    for (const [key, sub] of Object.entries(props)) {
      newProps[key] = convertNode(sub);
    }
    out.properties = newProps;
    // Strict: ALL properties required + no extras.
    out.required = Object.keys(newProps);
    out.additionalProperties = false;

    // Any property that was NOT originally required becomes nullable so the
    // model may legitimately emit null for it.
    const origRequired = Array.isArray(node.required) ? node.required : [];
    for (const key of Object.keys(newProps)) {
      if (!origRequired.includes(key)) {
        newProps[key] = makeNullable(newProps[key]);
      }
    }
  }

  if (isArrayType) {
    if (out.items === undefined) {
      throw new Error('INELIGIBLE: array without items');
    }
    if (Array.isArray(out.items)) {
      // Tuple validation is not supported in strict mode.
      throw new Error('INELIGIBLE: tuple items');
    }
    out.items = convertNode(out.items);
  }

  return out;
}

/**
 * Is `schema` ALREADY strict-compliant, exactly as authored? (No rewriting.)
 *
 * Used for the BUILT-IN tool schemas, which are hand-authored and must be sent
 * verbatim — we only need to decide whether `function.strict = true` may be set
 * on them. Claiming strict for a non-compliant schema makes Azure/OpenAI reject
 * the WHOLE request with a 400 ("'required' is required to be supplied and to
 * be an array including every key in properties"), which the agent loop then
 * hides behind its JSON-mode fallback — the request simply arrives with no
 * tools at all.
 *
 * Rules checked (per object level), mirroring OpenAI Structured Outputs:
 *   • only the supported keyword set
 *   • objects: `properties` present (an EMPTY properties map is fine — that is
 *     the canonical no-argument tool), `additionalProperties: false`, and every
 *     property key listed in `required`
 *   • arrays: a single `items` schema that is itself non-empty and compliant
 *   • anyOf: every branch compliant
 *
 * @param {object} schema a tool's `parameters`
 * @returns {boolean}
 */
export function isStrictCompliant(schema) {
  if (!isPlainObject(schema)) return false;

  const walk = (node) => {
    if (!isPlainObject(node)) return false;
    for (const k of Object.keys(node)) {
      if (!SUPPORTED_KEYWORDS.has(k)) return false;
    }

    const types = node.type === undefined
      ? []
      : (Array.isArray(node.type) ? node.type : [node.type]);

    if (types.includes('object')) {
      const props = node.properties;
      // An open-ended map (no `properties`, or `additionalProperties` used as a
      // value schema) cannot be expressed in strict mode.
      if (!isPlainObject(props)) return false;
      if (node.additionalProperties !== false) return false;
      const keys = Object.keys(props);
      const required = Array.isArray(node.required) ? node.required : [];
      if (keys.some(k => !required.includes(k))) return false;
      for (const sub of Object.values(props)) {
        if (!walk(sub)) return false;
      }
    }

    if (types.includes('array')) {
      const items = node.items;
      // Missing / tuple / empty-schema items — strict needs one typed schema.
      if (!isPlainObject(items) || Object.keys(items).length === 0) return false;
      if (!walk(items)) return false;
    }

    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) return false;
      if (!node.anyOf.every(walk)) return false;
    }

    return true;
  };

  return walk(schema);
}

/** Union a schema node's `type` with "null" (idempotent). */
function makeNullable(node) {
  if (!isPlainObject(node)) return node;
  if (node.anyOf) {
    // Add a {type:"null"} branch if not already nullable.
    const hasNull = node.anyOf.some(b => b && b.type === 'null');
    if (!hasNull) node.anyOf = [...node.anyOf, { type: 'null' }];
    return node;
  }
  if (node.type === undefined) return node;
  const types = Array.isArray(node.type) ? node.type.slice() : [node.type];
  if (!types.includes('null')) types.push('null');
  node.type = types;
  return node;
}

/**
 * Convert an arbitrary JSON-Schema (a tool's `parameters`) to a strict-compliant
 * one. Returns { schema, eligible }. When ineligible, `schema` is the original
 * (unmodified) so the caller can still send it without strict.
 *
 * @param {object} schema
 * @returns {{ schema: object, eligible: boolean }}
 */
export function toStrictSchema(schema) {
  if (!isPlainObject(schema)) {
    return { schema, eligible: false };
  }
  try {
    const converted = convertNode(structuredClone(schema));
    return { schema: converted, eligible: true };
  } catch (e) {
    if (e && typeof e.message === 'string' && e.message.startsWith('INELIGIBLE')) {
      return { schema, eligible: false };
    }
    throw e; // unexpected — surface it
  }
}
