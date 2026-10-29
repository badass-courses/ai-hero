import { Schema } from 'effect'
import type { JsonSchema } from 'effect'

import type { AnyContract } from '../contract.js'

export type JsonSchemaObject = JsonSchema.JsonSchema

/** A self-contained JSON Schema (2020-12) for a schema's wire form. */
export function jsonSchemaOf(schema: Schema.Top): JsonSchemaObject {
	const document = Schema.toJsonSchemaDocument(schema)
	return Object.keys(document.definitions).length > 0
		? { ...document.schema, $defs: document.definitions }
		: document.schema
}

const LOCAL_DEFS = '#/$defs/'

function rewriteRefs(value: unknown, refPrefix: string): unknown {
	if (Array.isArray(value))
		return value.map((item) => rewriteRefs(item, refPrefix))
	if (!value || typeof value !== 'object') return value
	return Object.fromEntries(
		Object.entries(value).map(([key, nested]) => [
			key,
			key === '$ref' &&
			typeof nested === 'string' &&
			nested.startsWith(LOCAL_DEFS)
				? `${refPrefix}${nested.slice(LOCAL_DEFS.length)}`
				: rewriteRefs(nested, refPrefix),
		]),
	)
}

/**
 * The wire schema, with named definitions hoisted into `definitions` and
 * references rewritten to `refPrefix`, so OpenAPI can share them under
 * `components/schemas`.
 */
export function jsonSchemaInto(
	schema: Schema.Top,
	definitions: Record<string, JsonSchemaObject>,
	refPrefix: string,
	keyPrefix = '',
): JsonSchemaObject {
	const document = Schema.toJsonSchemaDocument(schema)
	for (const [key, value] of Object.entries(document.definitions)) {
		definitions[`${keyPrefix}${key}`] = rewriteRefs(
			value,
			refPrefix,
		) as JsonSchemaObject
	}
	return rewriteRefs(document.schema, refPrefix) as JsonSchemaObject
}

/**
 * The `inputSchema` MCP and the catalog publish: always an object schema.
 * An empty Struct compiles to "anything but null"; tools need a plain
 * object, so that guard is dropped, as rat-stack's `inputJsonSchemaOf` does.
 */
export function inputJsonSchema(contract: AnyContract): JsonSchemaObject {
	const { not: nullGuard, ...schema } = jsonSchemaOf(contract.input)
	const guardOnly =
		nullGuard !== undefined &&
		JSON.stringify(nullGuard) === JSON.stringify({ type: 'null' })
	return {
		type: 'object',
		properties: {},
		...schema,
		...(guardOnly || nullGuard === undefined ? {} : { not: nullGuard }),
	}
}
