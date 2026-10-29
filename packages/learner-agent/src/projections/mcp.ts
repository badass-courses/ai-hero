import { Effect } from 'effect'

import type { AnyCapability } from '../contract.js'
import type { PromptDefinition } from '../prompts.js'
import { invoke, type InvokeResult } from './invoke.js'
import { inputJsonSchema } from './json-schema.js'

/**
 * A stateless MCP server over streamable HTTP: every POST carries one
 * JSON-RPC message or a batch, and every answer is plain JSON. No session
 * id, no server-sent events, so it runs on any serverless instance. Older
 * clients that open with `initialize` get a normal handshake.
 */

export const SUPPORTED_PROTOCOL_VERSIONS = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
] as const
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

export type McpServerInfo = {
	readonly name: string
	readonly title: string
	readonly version: string
	readonly instructions: string
}

type JsonRpcId = string | number | null

type JsonRpcRequest = {
	readonly jsonrpc: '2.0'
	readonly id?: JsonRpcId
	readonly method: string
	readonly params?: Record<string, unknown>
}

type JsonRpcResponse =
	| {
			readonly jsonrpc: '2.0'
			readonly id: JsonRpcId
			readonly result: unknown
	  }
	| {
			readonly jsonrpc: '2.0'
			readonly id: JsonRpcId
			readonly error: {
				readonly code: number
				readonly message: string
				readonly data?: unknown
			}
	  }

export const JSON_RPC = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internalError: -32603,
} as const

const ok = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
	jsonrpc: '2.0',
	id,
	result,
})
const fail = (
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse => ({
	jsonrpc: '2.0',
	id,
	error: data === undefined ? { code, message } : { code, message, data },
})

const isRequest = (value: unknown): value is JsonRpcRequest =>
	typeof value === 'object' &&
	value !== null &&
	(value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
	typeof (value as { method?: unknown }).method === 'string'

export const toolList = (capabilities: ReadonlyArray<AnyCapability>) =>
	capabilities.map(({ contract }) => ({
		name: contract.name,
		title: contract.title,
		description: contract.description,
		inputSchema: inputJsonSchema(contract),
		annotations: {
			title: contract.title,
			readOnlyHint: contract.annotations.readOnly,
			destructiveHint: contract.annotations.destructive,
			idempotentHint: contract.annotations.idempotent,
			openWorldHint: contract.annotations.openWorld,
		},
	}))

/** A capability outcome as an MCP `tools/call` result or JSON-RPC error. */
function toolResult(id: JsonRpcId, result: InvokeResult): JsonRpcResponse {
	switch (result._tag) {
		case 'Success':
			return ok(id, {
				content: [{ type: 'text', text: JSON.stringify(result.output) }],
				structuredContent: result.output,
			})
		case 'Failure':
			// Expected failures are tool results the model can read and act on.
			return ok(id, {
				content: [
					{ type: 'text', text: JSON.stringify({ error: result.error }) },
				],
				structuredContent: { error: result.error },
				isError: true,
			})
		case 'InvalidInput':
			return ok(id, {
				content: [
					{ type: 'text', text: `Invalid arguments: ${result.message}` },
				],
				isError: true,
			})
		case 'UnknownCapability':
			return fail(id, JSON_RPC.invalidParams, `Unknown tool: ${result.name}`)
		case 'Defect':
			return fail(id, JSON_RPC.internalError, 'Internal error')
	}
}

export type McpHandlerOptions = {
	readonly capabilities: ReadonlyArray<AnyCapability>
	readonly prompts: ReadonlyArray<PromptDefinition>
	readonly server: McpServerInfo
}

/** Answers one JSON-RPC message; notifications answer with nothing. */
export const handleMcpMessage = <R>(
	options: McpHandlerOptions,
	message: unknown,
) =>
	Effect.gen(function* () {
		if (!isRequest(message)) {
			return {
				response: fail(null, JSON_RPC.invalidRequest, 'Invalid request'),
				results: [],
			}
		}
		const results: InvokeResult[] = []
		// A message without an id is a notification and gets no reply.
		if (message.id === undefined) return { response: null, results }
		const id = message.id
		const params = message.params ?? {}

		switch (message.method) {
			case 'initialize': {
				const requested = params.protocolVersion
				const protocolVersion =
					SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ??
					LATEST_PROTOCOL_VERSION
				return {
					results,
					response: ok(id, {
						protocolVersion,
						capabilities: {
							tools: { listChanged: false },
							prompts: { listChanged: false },
						},
						serverInfo: {
							name: options.server.name,
							title: options.server.title,
							version: options.server.version,
						},
						instructions: options.server.instructions,
					}),
				}
			}
			case 'ping':
				return { results, response: ok(id, {}) }
			case 'tools/list':
				return {
					results,
					response: ok(id, { tools: toolList(options.capabilities) }),
				}
			case 'tools/call': {
				if (typeof params.name !== 'string') {
					return {
						results,
						response: fail(
							id,
							JSON_RPC.invalidParams,
							'tools/call needs a tool name',
						),
					}
				}
				const result = yield* invoke<R>(
					options.capabilities,
					params.name,
					params.arguments ?? {},
				)
				results.push(result)
				return { results, response: toolResult(id, result) }
			}
			case 'prompts/list':
				return {
					results,
					response: ok(id, {
						prompts: options.prompts.map((prompt) => ({
							name: prompt.name,
							title: prompt.title,
							description: prompt.description,
							arguments: prompt.arguments,
						})),
					}),
				}
			case 'prompts/get': {
				const prompt = options.prompts.find(
					(entry) => entry.name === params.name,
				)
				if (!prompt) {
					return {
						results,
						response: fail(
							id,
							JSON_RPC.invalidParams,
							`Unknown prompt: ${String(params.name)}`,
						),
					}
				}
				const args = Object.fromEntries(
					Object.entries(
						(params.arguments ?? {}) as Record<string, unknown>,
					).filter(
						(entry): entry is [string, string] => typeof entry[1] === 'string',
					),
				)
				const missing = prompt.arguments.find(
					(arg) => arg.required && !args[arg.name],
				)
				if (missing) {
					return {
						results,
						response: fail(
							id,
							JSON_RPC.invalidParams,
							`Missing prompt argument: ${missing.name}`,
						),
					}
				}
				const call = prompt.call(args)
				const result = yield* invoke<R>(
					options.capabilities,
					call.capability,
					call.input,
				)
				results.push(result)
				switch (result._tag) {
					case 'Success':
						return { results, response: ok(id, prompt.render(result.output)) }
					case 'Failure':
						return {
							results,
							response: fail(id, JSON_RPC.invalidParams, result.error.message, {
								error: result.error,
							}),
						}
					case 'InvalidInput':
						return {
							results,
							response: fail(id, JSON_RPC.invalidParams, result.message),
						}
					default:
						return {
							results,
							response: fail(id, JSON_RPC.internalError, 'Internal error'),
						}
				}
			}
			case 'resources/list':
				return { results, response: ok(id, { resources: [] }) }
			default:
				return {
					results,
					response: fail(
						id,
						JSON_RPC.methodNotFound,
						`Method not found: ${message.method}`,
					),
				}
		}
	})

const MCP_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8',
	'Cache-Control': 'private, no-store',
} as const

/** The streamable-HTTP endpoint: POST JSON-RPC in, JSON out. */
export const handleMcpRequest = <R>(
	options: McpHandlerOptions,
	request: Request,
) =>
	Effect.gen(function* () {
		if (request.method !== 'POST') {
			// No server-to-client stream: this server never pushes.
			return {
				results: [] as InvokeResult[],
				response: new Response(null, {
					status: 405,
					headers: { Allow: 'POST' },
				}),
			}
		}
		const text = yield* Effect.promise(() => request.text())
		const parsed = yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () => 'parse-error' as const,
		}).pipe(Effect.result)
		if (parsed._tag === 'Failure') {
			return {
				results: [] as InvokeResult[],
				response: new Response(
					JSON.stringify(fail(null, JSON_RPC.parseError, 'Parse error')),
					{
						status: 400,
						headers: MCP_HEADERS,
					},
				),
			}
		}

		const messages = Array.isArray(parsed.success)
			? parsed.success
			: [parsed.success]
		const answered = yield* Effect.forEach(messages, (message) =>
			handleMcpMessage<R>(options, message),
		)
		const responses = answered.flatMap((entry) =>
			entry.response ? [entry.response] : [],
		)
		const results = answered.flatMap((entry) => entry.results)

		if (responses.length === 0) {
			return { results, response: new Response(null, { status: 202 }) }
		}
		const body = Array.isArray(parsed.success) ? responses : responses[0]
		return {
			results,
			response: new Response(JSON.stringify(body), {
				status: 200,
				headers: MCP_HEADERS,
			}),
		}
	})
