/**
 * A tiny JSON Schema checker for the subset of draft 2020-12 that
 * `layouts/layout.schema.json` uses. It exists only so tests can prove the
 * published schema agrees with the hand-written validator without adding a
 * schema-validation dependency. Not exported from the package.
 *
 * Supported keywords: `$ref` (local `#/$defs/...`), `type`, `const`, `enum`,
 * `pattern`, `minLength`, `minimum`, `exclusiveMinimum`, `minItems`,
 * `required`, `properties`, `additionalProperties: false`, `items`, `oneOf`,
 * `anyOf`. Any other keyword (besides annotations) throws, so the schema
 * cannot silently outgrow this checker.
 */

type Schema = Readonly<Record<string, unknown>>;

const ANNOTATIONS = new Set(['$schema', '$defs', 'title', 'description']);
const SUPPORTED = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'pattern',
  'minLength',
  'minimum',
  'exclusiveMinimum',
  'minItems',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'oneOf',
  'anyOf',
]);

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      throw new Error(`Unsupported schema type "${type}".`);
  }
}

function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref "${ref}".`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    node = isRecord(node) ? node[part] : undefined;
  }
  if (!isRecord(node)) throw new Error(`Unresolved $ref "${ref}".`);
  return node;
}

/** True when `value` satisfies `schema` (resolving refs against `root`). */
export function matchesSchema(root: Schema, schema: Schema, value: unknown): boolean {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword) && !ANNOTATIONS.has(keyword)) {
      throw new Error(`Unsupported schema keyword "${keyword}".`);
    }
  }
  const ref = schema.$ref;
  if (typeof ref === 'string' && !matchesSchema(root, resolve(root, ref), value)) return false;

  if ('type' in schema && !typeMatches(schema.type as string, value)) return false;
  if ('const' in schema && schema.const !== value) return false;
  if ('enum' in schema && !(schema.enum as unknown[]).includes(value)) return false;
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      return false;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    const items = schema.items;
    if (isRecord(items) && !value.every((item: unknown) => matchesSchema(root, items, item))) {
      return false;
    }
  }
  if (isRecord(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const name of required as string[]) if (!(name in value)) return false;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, sub] of Object.entries(properties)) {
      if (name in value && isRecord(sub) && !matchesSchema(root, sub, value[name])) return false;
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) if (!(name in properties)) return false;
    }
  }
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const hits = (oneOf as Schema[]).filter((s) => matchesSchema(root, s, value)).length;
    if (hits !== 1) return false;
  }
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && !(anyOf as Schema[]).some((s) => matchesSchema(root, s, value))) {
    return false;
  }
  return true;
}
