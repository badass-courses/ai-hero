import type { Annotations, AnyCapability, AnyContract } from '../contract.js'
import type { PromptArgument, PromptDefinition } from '../prompts.js'
import {
	inputJsonSchema,
	jsonSchemaOf,
	type JsonSchemaObject,
} from './json-schema.js'

export type ToolCatalogEntry = {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly annotations: Annotations
	readonly input: JsonSchemaObject
	readonly output: JsonSchemaObject
	readonly failure: JsonSchemaObject
	/** The `_tag` of every failure the tool declares. */
	readonly failures: ReadonlyArray<string>
}

export type ToolCatalog = {
	readonly version: '1'
	readonly tools: ReadonlyArray<ToolCatalogEntry>
	readonly prompts: ReadonlyArray<{
		readonly name: string
		readonly title: string
		readonly description: string
		readonly arguments: ReadonlyArray<PromptArgument>
	}>
}

/** Every `_tag` constant reachable in a JSON Schema, following local refs. */
function tagsIn(
	schema: unknown,
	defs: Record<string, unknown>,
	seen = new Set<string>(),
): string[] {
	if (!schema || typeof schema !== 'object') return []
	const node = schema as Record<string, unknown>
	if (typeof node.$ref === 'string') {
		const key = node.$ref.split('/').pop() ?? ''
		if (seen.has(key)) return []
		seen.add(key)
		return tagsIn(defs[key], defs, seen)
	}
	const tag = (
		node.properties as Record<string, Record<string, unknown>> | undefined
	)?._tag
	if (tag) {
		if (typeof tag.const === 'string') return [tag.const]
		if (Array.isArray(tag.enum))
			return tag.enum.filter((v): v is string => typeof v === 'string')
	}
	const members = [node.anyOf, node.oneOf].flatMap((list) =>
		Array.isArray(list) ? list : [],
	)
	return members.flatMap((member) => tagsIn(member, defs, seen))
}

export function failureTags(contract: AnyContract): ReadonlyArray<string> {
	const schema = jsonSchemaOf(contract.failure)
	const defs = (schema.$defs ?? {}) as Record<string, unknown>
	return [...new Set(tagsIn(schema, defs))]
}

export function toToolCatalog(
	capabilities: ReadonlyArray<AnyCapability>,
	prompts: ReadonlyArray<PromptDefinition>,
): ToolCatalog {
	return {
		version: '1',
		tools: capabilities.map(({ contract }) => ({
			name: contract.name,
			title: contract.title,
			description: contract.description,
			annotations: contract.annotations,
			input: inputJsonSchema(contract),
			output: jsonSchemaOf(contract.output),
			failure: jsonSchemaOf(contract.failure),
			failures: failureTags(contract),
		})),
		prompts: prompts.map((prompt) => ({
			name: prompt.name,
			title: prompt.title,
			description: prompt.description,
			arguments: prompt.arguments,
		})),
	}
}
