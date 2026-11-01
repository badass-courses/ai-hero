import { Effect } from 'effect'

import type { AnyCapability, AnyContract } from '../contract.js'
import { findCapability, invoke, type InvokeResult } from './invoke.js'
import { inputJsonSchema } from './json-schema.js'

const JSON_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8',
	'Cache-Control': 'private, no-store',
} as const

const json = (
	body: unknown,
	status: number,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { ...JSON_HEADERS, ...headers },
	})

/**
 * Query strings are all text; read each parameter with the type its input
 * schema declares, so GET and POST decode through the same contract.
 */
export function inputFromQuery(contract: AnyContract, params: URLSearchParams) {
	const properties = (inputJsonSchema(contract).properties ?? {}) as Record<
		string,
		{ readonly type?: unknown }
	>
	const input: Record<string, unknown> = {}
	for (const [key, value] of params) {
		const type = properties[key]?.type
		input[key] =
			type === 'number' || type === 'integer'
				? Number(value)
				: type === 'boolean'
					? value === 'true'
					: value
	}
	return input
}

/**
 * The HTTP envelope: `{ ok, capability, ...output }` on success, or
 * `{ ok: false, capability, error }`. Both carry `next_actions` at the top.
 */
export function toHttpResponse(result: InvokeResult): Response {
	switch (result._tag) {
		case 'Success':
			return json(
				{ ok: true, capability: result.capability, ...result.output },
				200,
			)
		case 'Failure':
			return json(
				{
					ok: false,
					capability: result.capability,
					error: result.error,
					next_actions: result.error.next_actions ?? [],
				},
				result.status,
				result.error._tag === 'RateLimited' &&
					typeof result.error.retryAfterSeconds === 'number'
					? { 'Retry-After': String(result.error.retryAfterSeconds) }
					: {},
			)
		case 'InvalidInput':
			return json(
				{
					ok: false,
					capability: result.capability,
					error: { _tag: 'InvalidInput', message: result.message },
					next_actions: [],
				},
				400,
			)
		case 'UnknownCapability':
			return json(
				{
					ok: false,
					capability: result.name,
					error: {
						_tag: 'UnknownCapability',
						message: `No capability named ${result.name}.`,
					},
					next_actions: [],
				},
				404,
			)
		case 'Defect':
			return json(
				{
					ok: false,
					capability: result.capability,
					error: {
						_tag: 'InternalError',
						message: 'Something went wrong. Try again.',
					},
					next_actions: [],
				},
				500,
			)
	}
}

/** Reads the call's input from the request: query on GET, JSON body on POST. */
export const readHttpInput = (
	contract: AnyContract | undefined,
	request: Request,
) =>
	Effect.gen(function* () {
		if (request.method === 'GET' || request.method === 'HEAD') {
			return contract
				? inputFromQuery(contract, new URL(request.url).searchParams)
				: {}
		}
		const text = yield* Effect.promise(() => request.text())
		if (text.trim() === '') return {}
		return yield* Effect.try({
			try: () => JSON.parse(text) as unknown,
			catch: () => 'invalid-json' as const,
		})
	})

export const handleHttpRequest = <R>(
	capabilities: ReadonlyArray<AnyCapability>,
	request: Request,
	name: string,
) =>
	Effect.gen(function* () {
		const contract = findCapability(capabilities, name)?.contract
		if (
			request.method !== 'POST' &&
			!(contract?.annotations.readOnly && request.method === 'GET')
		) {
			return {
				result: null,
				response: json(
					{
						ok: false,
						error: {
							_tag: 'MethodNotAllowed',
							message: 'Use POST, or GET for read-only capabilities.',
						},
						next_actions: [],
					},
					405,
					{ Allow: contract?.annotations.readOnly ? 'GET, POST' : 'POST' },
				),
			}
		}
		const input = yield* readHttpInput(contract, request).pipe(Effect.result)
		if (input._tag === 'Failure') {
			const result: InvokeResult = {
				_tag: 'InvalidInput',
				capability: name,
				message: 'The request body is not valid JSON.',
			}
			return { result, response: toHttpResponse(result) }
		}
		const result = yield* invoke<R>(capabilities, name, input.success)
		return { result, response: toHttpResponse(result) }
	})
