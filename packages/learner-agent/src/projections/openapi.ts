import type { AnyCapability } from '../contract.js'
import { InvalidInput, RateLimited, failureStatus } from '../errors.js'
import { failureTags } from './catalog.js'
import {
	inputJsonSchema,
	jsonSchemaInto,
	type JsonSchemaObject,
} from './json-schema.js'

export type OpenApiOptions = {
	/** Path prefix the HTTP projection is mounted at, e.g. `/api/learner`. */
	readonly basePath: string
	readonly title?: string
	readonly version?: string
	/** Prefix for component schema names, so a merged document cannot collide. */
	readonly componentPrefix?: string
}

/**
 * OpenAPI 3.1 paths for every capability, from the same contract schemas
 * the MCP and HTTP projections decode with. Read-only capabilities get a GET
 * with query parameters as well as the POST.
 */
export function toOpenApi(
	capabilities: ReadonlyArray<AnyCapability>,
	options: OpenApiOptions,
) {
	const schemas: Record<string, JsonSchemaObject> = {}
	const refPrefix = `#/components/schemas/${options.componentPrefix ?? ''}`
	const paths: Record<string, Record<string, unknown>> = {}

	// The dispatcher answers these for every capability, before or around the
	// handler: input that does not decode, and the rate limit.
	const invalidInput = jsonSchemaInto(
		InvalidInput,
		schemas,
		refPrefix,
		options.componentPrefix,
	)
	const rateLimited = jsonSchemaInto(
		RateLimited,
		schemas,
		refPrefix,
		options.componentPrefix,
	)

	for (const { contract } of capabilities) {
		const input = inputJsonSchema(contract)
		const output = jsonSchemaInto(
			contract.output,
			schemas,
			refPrefix,
			options.componentPrefix,
		)
		const failure = jsonSchemaInto(
			contract.failure,
			schemas,
			refPrefix,
			options.componentPrefix,
		)

		const success = {
			description: `${contract.title}. Carries next_actions.`,
			content: {
				'application/json': {
					schema: {
						allOf: [
							{
								type: 'object',
								required: ['ok', 'capability'],
								properties: {
									ok: { const: true },
									capability: { const: contract.name },
								},
							},
							output,
						],
					},
				},
			},
		}
		const envelope = (error: JsonSchemaObject) => ({
			type: 'object',
			required: ['ok', 'capability', 'error', 'next_actions'],
			properties: {
				ok: { const: false },
				capability: { const: contract.name },
				error,
				next_actions: { type: 'array' },
			},
		})
		const responses: Record<string, unknown> = {
			'200': success,
			'400': {
				description: 'InvalidInput: the input does not match the schema.',
				content: { 'application/json': { schema: envelope(invalidInput) } },
			},
			'429': {
				description: 'RateLimited: retry after `Retry-After` seconds.',
				headers: {
					'Retry-After': {
						description: 'Seconds until the next call is allowed.',
						schema: { type: 'integer' },
					},
				},
				content: { 'application/json': { schema: envelope(rateLimited) } },
			},
		}
		for (const tag of failureTags(contract)) {
			const status = String(failureStatus[tag] ?? 422)
			if (status === '429') continue
			const existing = responses[status] as { description: string } | undefined
			responses[status] = {
				description: existing ? `${existing.description} Or ${tag}.` : tag,
				content: { 'application/json': { schema: envelope(failure) } },
			}
		}

		const operation = {
			summary: contract.title,
			description: contract.description,
			tags: ['learner'],
			security: [{}, { bearerAuth: [] }],
			'x-annotations': contract.annotations,
			responses,
		}
		const properties = (input.properties ?? {}) as Record<
			string,
			JsonSchemaObject
		>
		const required = new Set(
			(input.required as ReadonlyArray<string> | undefined) ?? [],
		)

		const path: Record<string, unknown> = {
			post: {
				...operation,
				operationId: contract.name,
				requestBody: {
					required: false,
					content: { 'application/json': { schema: input } },
				},
			},
		}
		if (contract.annotations.readOnly) {
			path.get = {
				...operation,
				operationId: `${contract.name}_get`,
				parameters: Object.entries(properties).map(([name, schema]) => ({
					name,
					in: 'query',
					required: required.has(name),
					schema,
				})),
			}
		}
		paths[`${options.basePath}/${contract.name}`] = path
	}

	return {
		openapi: '3.1.0',
		info: {
			title: options.title ?? 'AI Hero learner API',
			version: options.version ?? '1',
		},
		paths,
		components: {
			schemas,
			securitySchemes: {
				bearerAuth: {
					type: 'http',
					scheme: 'bearer',
					description:
						'A learner agent token (scope learner:read) or a device token.',
				},
			},
		},
	}
}
