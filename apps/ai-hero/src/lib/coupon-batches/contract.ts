import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, open, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import { PRODUCT, TEMPLATE } from './namespace'
export { PRODUCT, TEMPLATE } from './namespace'
export const PAGE = 100
export const REQUEST_ALARM = 3000
export const DAILY_ALARM = 4000
export const POLICY_REVISION = '1'
export const EXPORT_MS = 24 * 3600_000
const PREVIEW_MS = 5 * 60_000
const MAX_TTL_MS = 30 * 86400_000
const EXPIRY_MARGIN_MS = 2000

export class BatchProblem extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code)
	}
}
const invalid = (): never => {
	throw new BatchProblem(400, 'invalid_manifest')
}
export const key = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const envelope = z
	.object({
		campaignRef: key,
		templateId: z.literal(TEMPLATE),
		template: z
			.object({
				productId: z.literal(PRODUCT),
				percentageDiscount: z.literal(1),
				maxUses: z.literal(1),
				deadlineAt: z.string().datetime({ offset: true }),
			})
			.strict(),
		previewReceipt: z.string().max(128).optional(),
	})
	.strict()
const item = z.object({ intentKey: key }).strict()

export type Manifest = {
	campaignRef: string
	terms: z.infer<typeof envelope>['template']
	previewReceipt?: string
	total: number
	fingerprint: string
	itemFingerprint: string
	pages(): AsyncGenerator<string[]>
	close(): Promise<void>
}
export const sha = (value: string) =>
	createHash('sha256').update(value).digest('hex')

/** Frame the top-level JSON object and stream only its items array. JSON.parse
 * still does the syntax checking on each bounded value. No aggregate size
 * cutoff: request/transport failures may interrupt a spool, not admit a prefix. */
async function* frames(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	let mode:
		| 'start'
		| 'key-first'
		| 'key'
		| 'colon'
		| 'value'
		| 'separator'
		| 'item-first'
		| 'item'
		| 'item-separator'
		| 'done' = 'start'
	let remaining = ''
	let token = ''
	let name = ''
	let quoted = false
	let escaped = false
	let depth = 0
	const append = (c: string) => {
		token += c
		if (token.length > 4096) invalid()
	}
	const finish = () => {
		let value: unknown
		try {
			value = JSON.parse(token)
		} catch {
			invalid()
		}
		token = ''
		return value
	}
	try {
		for (;;) {
			const next = await reader.read()
			remaining = decoder.decode(next.value, { stream: !next.done })
			for (const c of remaining) {
				if (quoted) {
					append(c)
					if (escaped) escaped = false
					else if (c === '\\') escaped = true
					else if (c === '"') {
						quoted = false
						if (mode === 'key' || mode === 'key-first') {
							name = finish() as string
							mode = 'colon'
						}
					}
					continue
				}
				if (depth > 0) {
					append(c)
					if (c === '"') quoted = true
					else if (c === '{' || c === '[') depth++
					else if (c === '}' || c === ']') depth--
					if (depth === 0 && (mode === 'item-first' || mode === 'item')) {
						yield { name: 'items', value: finish(), item: true }
						mode = 'item-separator'
					}
					continue
				}
				if (!token && /[\x20\x09\x0a\x0d]/.test(c)) continue
				switch (mode) {
					case 'start':
						if (c !== '{') invalid()
						mode = 'key-first'
						break
					case 'key-first':
					case 'key':
						if (c !== '"') invalid()
						append(c)
						quoted = true
						break
					case 'colon':
						if (c !== ':') invalid()
						mode = 'value'
						break
					case 'value':
						if (name === 'items') {
							if (c !== '[') invalid()
							yield { name, value: undefined, item: false }
							mode = 'item-first'
						} else if (c === ',' || c === '}') {
							yield { name, value: finish(), item: false }
							mode = c === ',' ? 'key' : 'done'
						} else {
							append(c)
							if (c === '"') quoted = true
							else if (c === '{' || c === '[') depth++
						}
						break
					case 'item-first':
					case 'item':
						if (mode === 'item-first' && c === ']') {
							mode = 'separator'
							break
						}
						if (c !== '{') invalid()
						append(c)
						depth = 1
						break
					case 'item-separator':
						if (c === ']') mode = 'separator'
						else if (c === ',') mode = 'item'
						else invalid()
						break
					case 'separator':
						if (c === '}') mode = 'done'
						else if (c === ',') mode = 'key'
						else invalid()
						break
					case 'done':
						invalid()
				}
			}
			if (next.done) break
		}
		if (mode !== 'done') invalid()
	} catch (error) {
		if (error instanceof BatchProblem) throw error
		return invalid()
	} finally {
		void reader.cancel().catch(() => {})
		reader.releaseLock()
	}
}

export async function readManifest(request: Request): Promise<Manifest> {
	if (!request.body) throw new BatchProblem(400, 'invalid_manifest')
	const dir = await mkdtemp(join(tmpdir(), 'aih-coupon-'))
	const path = join(dir, 'manifest')
	const close = async () => {
		await unlink(path).catch(() => {})
		await rmdir(dir).catch(() => {})
	}
	try {
		const handle = await open(path, 'wx', 0o600)
		const fields: Record<string, unknown> = Object.create(null)
		const seen = new Set<string>()
		const intentKeys = new Set<string>()
		const digest = createHash('sha256')
		let total = 0
		let pending: string[] = []
		try {
			for await (const frame of frames(request.body)) {
				if (!frame.item) {
					if (
						![
							'items',
							'campaignRef',
							'templateId',
							'template',
							'previewReceipt',
						].includes(frame.name) ||
						seen.has(frame.name)
					)
						invalid()
					seen.add(frame.name)
					if (frame.name !== 'items') fields[frame.name] = frame.value
					continue
				}
				const parsed = item.safeParse(frame.value)
				if (!parsed.success) throw new BatchProblem(400, 'invalid_item')
				if (intentKeys.has(parsed.data.intentKey))
					throw new BatchProblem(400, 'duplicate_intent_key')
				intentKeys.add(parsed.data.intentKey)
				const line = `${parsed.data.intentKey}\n`
				digest.update(line)
				pending.push(line)
				total++
				if (pending.length === PAGE) {
					await handle.writeFile(pending.join(''))
					pending = []
				}
			}
			if (pending.length) await handle.writeFile(pending.join(''))
		} finally {
			await handle.close()
		}
		const parsed = envelope.safeParse(fields)
		if (!parsed.success || !total)
			throw new BatchProblem(400, 'invalid_manifest')
		const { campaignRef, template, previewReceipt } = parsed.data
		const deadline = new Date(template.deadlineAt)
		if (!Number.isFinite(+deadline))
			throw new BatchProblem(400, 'invalid_deadline')
		// MySQL coupon expiry is second precision. Reject a fractional instant
		// rather than silently shorten or extend the signed deadline.
		if (+deadline % 1000 !== 0) throw new BatchProblem(400, 'invalid_deadline')
		const terms = { ...template, deadlineAt: deadline.toISOString() }
		const itemFingerprint = sha(
			JSON.stringify([POLICY_REVISION, TEMPLATE, campaignRef, terms]),
		)
		return {
			campaignRef,
			terms,
			previewReceipt,
			total,
			itemFingerprint,
			fingerprint: sha(`${itemFingerprint}:${digest.digest('hex')}`),
			close,
			async *pages() {
				const stream = createReadStream(path)
				const lines = createInterface({ input: stream, crlfDelay: Infinity })
				try {
					let page: string[] = []
					for await (const line of lines) {
						page.push(line)
						if (page.length === PAGE) {
							yield page
							page = []
						}
					}
					if (page.length) yield page
				} finally {
					lines.close()
					stream.destroy()
				}
			},
		}
	} catch (error) {
		await close()
		throw error
	}
}

export function checkDeadline(deadline: string, now: Date) {
	const delta = +new Date(deadline) - +now
	if (
		!Number.isFinite(delta) ||
		delta <= EXPIRY_MARGIN_MS ||
		delta > MAX_TTL_MS
	) {
		throw new BatchProblem(422, 'invalid_deadline')
	}
}

function signature(
	actor: string,
	fingerprint: string,
	expires: number,
	secret: string,
) {
	return createHmac('sha256', secret)
		.update(
			JSON.stringify([
				'aih-coupon-preview',
				POLICY_REVISION,
				actor,
				fingerprint,
				expires,
			]),
		)
		.digest('hex')
}

export function issuePreview(
	actor: string,
	fingerprint: string,
	now: Date,
	secret: string,
) {
	const expires = +now + PREVIEW_MS
	return `${expires}.${signature(actor, fingerprint, expires, secret)}`
}

export function confirmPreview(
	receipt: string | undefined,
	actor: string,
	fingerprint: string,
	now: Date,
	secret: string,
) {
	const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(receipt ?? '')
	if (match) {
		const expires = Number(match[1])
		if (
			expires > +now &&
			expires <= +now + PREVIEW_MS &&
			timingSafeEqual(
				Buffer.from(match[2]!, 'hex'),
				Buffer.from(signature(actor, fingerprint, expires, secret), 'hex'),
			)
		)
			return
	}
	throw new BatchProblem(409, 'preview_required')
}
