import { z } from 'zod'

import { BatchProblem, key, PAGE, readManifest } from './contract'
import { INLINE_MS, type createCouponBatchService } from './service'
import { COUPON_BATCH_MINT_SCOPE } from '@/lib/personal-access-tokens'

const base = '/api/commerce/coupon-batches'
const id = z.string().regex(/^cb_[0-9a-f]{64}$/)
const cursorSchema = z.number().int().min(0).max(2147483647)
const lookupSchema = z
	.object({ intentKeys: z.array(key).min(1).max(PAGE) })
	.strict()
const exportSchema = z
	.object({ batchId: id, cursor: cursorSchema.optional() })
	.strict()
const headers = {
	'Cache-Control': 'private, no-store',
	Vary: 'Authorization',
	'X-Robots-Tag': 'noindex',
	'Referrer-Policy': 'no-referrer',
}

function bearer(request: Request) {
	const token = /^Bearer (\S+)$/i.exec(
		request.headers.get('authorization') ?? '',
	)?.[1]
	if (!token) throw new BatchProblem(401, 'coupon_batch_unauthorized')
	return token
}

// Small read-only envelopes are bounded independently of mint volume.
async function readSmall(request: Request) {
	if (!request.body) throw new BatchProblem(400, 'invalid_request')
	const reader = request.body.getReader()
	let size = 0
	const chunks: Uint8Array[] = []
	try {
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			size += value.length
			if (size > 16_384) throw new Error('invalid_request')
			chunks.push(value)
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
	} catch {
		throw new BatchProblem(400, 'invalid_request')
	} finally {
		void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

function validate<T>(schema: z.ZodType<T>, raw: unknown) {
	const parsed = schema.safeParse(raw)
	if (!parsed.success) throw new BatchProblem(400, 'invalid_request')
	return parsed.data
}

async function respond(run: () => Promise<Response>) {
	try {
		return await run()
	} catch (error) {
		const { status, code } =
			error instanceof BatchProblem
				? error
				: { status: 503, code: 'coupon_batch_unavailable' }
		return Response.json(
			{ type: `urn:aih:coupon-batches:${code}`, title: code, status },
			{
				status,
				headers: {
					...headers,
					'Content-Type': 'application/problem+json',
					...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
				},
			},
		)
	}
}

export function couponBatchHandlers(
	service: ReturnType<typeof createCouponBatchService>,
	wake: () => void,
) {
	return {
		preview: (request: Request) =>
			respond(async () => {
				const token = bearer(request)
				await service.authorize(token, COUPON_BATCH_MINT_SCOPE)
				const manifest = await readManifest(request)
				try {
					return Response.json(await service.preview(token, manifest), {
						headers,
					})
				} finally {
					await manifest.close()
				}
			}),
		submit: (request: Request) =>
			respond(async () => {
				const started = performance.now()
				const token = bearer(request)
				await service.authorize(token, COUPON_BATCH_MINT_SCOPE)
				const idempotencyKey = validate(
					key,
					request.headers.get('idempotency-key'),
				)
				const manifest = await readManifest(request)
				try {
					const { batchId, principalId, initialStatus } = await service.admit(
						token,
						idempotencyKey,
						manifest,
					)
					let status =
						initialStatus ??
						(await service.statusForSubmit(batchId, principalId))
					const remaining = INLINE_MS - (performance.now() - started)
					if (initialStatus && manifest.total <= PAGE && remaining > 0) {
						// Race both mint and readback against the inline deadline. Admission
						// has already committed; a timed-out read never holds the response.
						let timer: ReturnType<typeof setTimeout> | undefined
						const inline = async () => {
							await service.runChunk(batchId)
							return service.statusForSubmit(batchId, principalId)
						}
						try {
							status =
								(await Promise.race([
									inline().catch(() => null),
									new Promise<null>((resolve) => {
										timer = setTimeout(() => resolve(null), remaining)
									}),
								])) ?? status
						} finally {
							clearTimeout(timer)
						}
					}
					if (status.counts.queued) {
						try {
							wake()
						} catch {
							/* Sweeper owns recovery. */
						}
					}
					const queued =
						status.counts.queued > 0 ||
						(initialStatus !== null && manifest.total > PAGE)
					return Response.json(status, {
						status: queued ? 202 : 200,
						headers: { ...headers, Location: `${base}/${batchId}` },
					})
				} finally {
					await manifest.close()
				}
			}),
		status: (request: Request, batchId: string) =>
			respond(async () => {
				const token = bearer(request)
				const cursor = new URL(request.url).searchParams.get('cursor') ?? '0'
				if (!/^\d{1,10}$/.test(cursor))
					throw new BatchProblem(400, 'invalid_request')
				return Response.json(
					await service.status(
						token,
						validate(id, batchId),
						validate(cursorSchema, Number(cursor)),
					),
					{ headers },
				)
			}),
		lookup: (request: Request) =>
			respond(async () => {
				const token = bearer(request)
				const input = validate(lookupSchema, await readSmall(request))
				return Response.json(await service.lookup(token, input.intentKeys), {
					headers,
				})
			}),
		exportPage: (request: Request) =>
			respond(async () => {
				const token = bearer(request)
				const input = validate(exportSchema, await readSmall(request))
				return Response.json(
					await service.exportPage(token, input.batchId, input.cursor ?? 0),
					{ headers },
				)
			}),
	}
}
