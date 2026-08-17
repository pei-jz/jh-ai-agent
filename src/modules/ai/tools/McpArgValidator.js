// McpArgValidator — runtime argument validation for third-party MCP tool calls.
//
// strictSchema.js rewrites schemas so the LLM ADVERTISES well-typed arguments;
// it never checks what actually ARRIVES. A model can still emit a wrong type,
// drop a required field, or add a stray key, and today that payload is forwarded
// verbatim to the MCP server, which replies with a cryptic parse error (or worse,
// silently ignores the malformed field and acts on a partial request).
//
// This module validates the actual call arguments against the tool's
// `inputSchema` BEFORE the request crosses to the server. It is intentionally a
// small, dependency-free JSON-Schema (draft-07 subset) validator — enough to
// cover what MCP servers actually publish:
//   • type / enum / required / properties / items / additionalProperties
//   • anyOf (first passing branch wins)
//   • number/integer/string/boolean/object/array/null
// Unsupported keywords are skipped (never a hard failure); a schema that is
// missing or not an object means "no constraints" → valid.
//
// Failure is reported as a list of human-readable errors so the agent can fix
// the call and retry instead of guessing what the server meant.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True when `value` satisfies the `type` keyword (string | array of strings). */
function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  for (const t of types) {
    switch (t) {
      case 'null': if (value === null) return true; break;
      case 'string': if (typeof value === 'string') return true; break;
      case 'boolean': if (typeof value === 'boolean') return true; break;
      case 'number': if (typeof value === 'number' && Number.isFinite(value)) return true; break;
      case 'integer': if (typeof value === 'number' && Number.isInteger(value)) return true; break;
      case 'object': if (isPlainObject(value)) return true; break;
      case 'array': if (Array.isArray(value)) return true; break;
      default: break;
    }
  }
  return false;
}

/**
 * Validate one value against a schema node.
 *
 * @param {*} value the runtime argument value
 * @param {object} node a JSON-Schema node (may be absent)
 * @param {string} path human-readable path for error messages ('', '.rows[2]')
 * @param {string[]} errors accumulated error strings
 */
function validateNode(value, node, path, errors) {
  if (!isPlainObject(node)) return; // no constraints → anything goes

  // anyOf: the value must satisfy at least one branch; errors only if none.
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    let ok = false;
    for (const branch of node.anyOf) {
      const branchErrors = [];
      validateNode(value, branch, path, branchErrors);
      if (branchErrors.length === 0) { ok = true; break; }
    }
    if (!ok) {
      errors.push(`"${path}" does not match any of the allowed shapes`);
      return;
    }
  }

  if (node.type !== undefined && !matchesType(value, node.type)) {
    const want = Array.isArray(node.type) ? node.type.join(' or ') : node.type;
    const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    errors.push(`"${path}" must be ${want}, got ${got}`);
    return; // type mismatch is terminal for this node
  }

  if (node.enum !== undefined && !node.enum.some(e => e === value)) {
    errors.push(`"${path}" must be one of ${JSON.stringify(node.enum)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(value)) {
    if (isPlainObject(node.items)) {
      value.forEach((item, i) => validateNode(item, node.items, `${path}[${i}]`, errors));
    }
    return;
  }

  if (isPlainObject(value) && isPlainObject(node.properties)) {
    const required = Array.isArray(node.required) ? node.required : [];
    for (const [key, sub] of Object.entries(node.properties)) {
      const subValue = value[key];
      if (subValue === undefined) continue;
      // A null on an OPTIONAL property means "omitted", not a type error.
      // strictSchema.js makes every non-required property nullable when the
      // tool is advertised (Structured Outputs requires all keys in `required`),
      // so the model is INSTRUCTED to send null instead of dropping the key —
      // validating that against the original, non-nullable schema would reject
      // every well-formed call that leaves an optional argument out.
      if (subValue === null && !required.includes(key)) continue;
      validateNode(subValue, sub, path ? `${path}.${key}` : key, errors);
    }
    // required: present AND not undefined (null is a valid "present" value).
    for (const req of required) {
      if (value[req] === undefined) {
        errors.push(`"${path ? `${path}.${req}` : req}" is required but missing`);
      }
    }
    // additionalProperties: false → reject unknown keys (case-sensitive).
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(node.properties, key)) {
          errors.push(`unknown property "${path ? `${path}.${key}` : key}" (not in the tool schema)`);
        }
      }
    }
  }
}

/**
 * Validate a tool-call's arguments against its input schema.
 *
 * @param {object} args the actual arguments (may be undefined/null/partial)
 * @param {object} [schema] the tool's `inputSchema` (JSON-Schema)
 * @returns {{ valid: boolean, errors: string[] }}
 *   valid:false when at least one constraint is violated. A missing/opaque
 *   schema yields valid:true — absence of information is not an error.
 */
export function validateMcpArgs(args, schema) {
  if (!isPlainObject(schema)) return { valid: true, errors: [] };
  const errors = [];
  validateNode(args || {}, schema, '', errors);
  return { valid: errors.length === 0, errors };
}
