// VBW host plugin — defineTool binding.
//
// The canonical contract is `@deepseek-ai/dsh-tools` (README L38-L64:
// `ctx.tools.register(defineTool({ name, description, parameters, output,
// execute }))`). That package is pinned to the DSH shared runtime and is NOT
// published to npm at the pinned version (0.2.2-rc.1), so a user-installed
// bundle cannot declare it as an installable dependency, and a bare import
// from a linked package outside the runtime tree does not resolve.
//
// Strategy: prefer the real package when the runtime made it resolvable;
// otherwise use this local replica that emits the exact registry-ready shape
// defineTool produces in @deepseek-ai/dsh-tools 0.2.2-rc.1 (lib/index.js
// L310-L359): parameters compiled from the DSL subset to raw JSON Schema
// ({ type: 'object', properties, required? }), arguments validated before
// execution, violations thrown as a ToolArgsError-shaped error, render
// delegated unchanged. The registry (`ToolsService.register`) performs no
// identity checks — it only requires `output.render` and a supported
// `output.schema` — so both paths produce equivalent registrations.

let realDefineTool;
try {
	const mod = await import('@deepseek-ai/dsh-tools');
	if (mod && typeof mod.defineTool === 'function') realDefineTool = mod.defineTool;
} catch {
	// Not resolvable from this install — the local replica below is used.
}

/** Invalid model-generated arguments (mirrors dsh-tools ToolArgsError shape). */
class ToolArgsError extends Error {
	constructor(violations) {
		super(`invalid arguments: ${violations.join('; ')}`);
		this.name = 'ToolArgsError';
		this.violations = violations;
	}
}

function jsonTypeOf(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	return typeof value;
}

/** Convert one parameter DSL node to a raw JSON Schema node. */
function propertyToSchema(spec) {
	const schema = { type: spec.type };
	if (spec.description !== undefined) schema.description = spec.description;
	if (spec.enum !== undefined) schema.enum = spec.enum;
	if (spec.items !== undefined) schema.items = propertyToSchema(spec.items);
	if (spec.type === 'object' && spec.properties !== undefined) {
		const properties = {};
		const required = [];
		for (const [key, child] of Object.entries(spec.properties)) {
			properties[key] = propertyToSchema(child);
			if (child.required === true) required.push(key);
		}
		schema.properties = properties;
		if (required.length > 0) schema.required = required;
	}
	return schema;
}

/**
 * Compile the implicit open parameter object into raw JSON Schema — the same
 * output shape as dsh-tools `parameterSchemaSpecToJsonSchema` (L274-L283):
 * `{ type: 'object', properties, required? }` with no additionalProperties
 * restriction.
 */
export function parameterSchemaSpecToJsonSchema(spec) {
	const properties = {};
	const required = [];
	for (const [key, child] of Object.entries(spec ?? {})) {
		properties[key] = propertyToSchema(child);
		if (child.required === true) required.push(key);
	}
	const schema = { type: 'object', properties };
	if (required.length > 0) schema.required = required;
	return schema;
}

/** Minimal JSON-Schema walk over the type/required/properties/items subset. */
function validateAgainst(schema, value, at, violations) {
	if (value === undefined) return; // presence is enforced by the parent object
	if (schema.type !== undefined) {
		const actual = jsonTypeOf(value);
		const ok = schema.type === 'integer'
			? actual === 'number' && Number.isInteger(value)
			: actual === schema.type;
		if (!ok) {
			violations.push(`${at || 'arguments'}: expected ${schema.type}, got ${actual}`);
			return;
		}
	}
	if (schema.type === 'object' && schema.properties !== undefined) {
		for (const key of schema.required ?? []) {
			if (value[key] === undefined) violations.push(`${at ? `${at}.${key}` : key}: required property missing`);
		}
		for (const [key, child] of Object.entries(schema.properties)) {
			if (value[key] !== undefined) validateAgainst(child, value[key], at ? `${at}.${key}` : key, violations);
		}
	}
	if (schema.type === 'array' && schema.items !== undefined) {
		value.forEach((item, index) => validateAgainst(schema.items, item, `${at}[${index}]`, violations));
	}
}

/** Returns path-qualified violations; empty means valid (README L295-L302). */
export function validateJsonSchemaValue(schema, args) {
	const violations = [];
	validateAgainst(schema, args, '', violations);
	return violations;
}

/** Local replica of dsh-tools `defineTool` (registry-ready output, L310-L359). */
function localDefineTool(options) {
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	}
	const userExecute = options.execute;
	const userRender = options.output.render;
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = options.output.schema;
	const validate = (args) => validateJsonSchemaValue(parameters, args);
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			}
		},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	return tool;
}

/**
 * The `defineTool` used by this plugin: the real @deepseek-ai/dsh-tools
 * export when the runtime resolves it, otherwise the local replica above.
 */
export const defineTool = realDefineTool ?? localDefineTool;
