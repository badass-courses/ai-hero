import {
	clientBuyPathSchema,
	type BuyPathContext,
	type ClientBuyPathEvent,
} from './schema'

type IngestDependencies = {
	limit: (key: string) => Promise<boolean>
	context: (event: ClientBuyPathEvent) => Promise<BuyPathContext | null>
	emit: (context: BuyPathContext, event: ClientBuyPathEvent) => Promise<void>
}
export async function ingestBuyPath(
	request: Request,
	dependencies: IngestDependencies,
) {
	if (request.headers.get('origin') !== new URL(request.url).origin)
		return new Response(null, { status: 403 })
	if (
		!(await dependencies.limit(
			request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
				'unknown',
		))
	)
		return new Response(null, { status: 429 })
	if (Number(request.headers.get('content-length')) > 2048)
		return new Response(null, { status: 413 })
	const reader = request.body?.getReader()
	if (!reader) return new Response(null, { status: 400 })
	const chunks: Uint8Array[] = []
	let length = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		length += value.byteLength
		if (length > 2048) {
			await reader.cancel()
			return new Response(null, { status: 413 })
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(length)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	const body = new TextDecoder().decode(bytes)
	let input: unknown
	try {
		input = JSON.parse(body)
	} catch {
		return new Response(null, { status: 400 })
	}
	const parsed = clientBuyPathSchema.safeParse(input)
	if (!parsed.success) return new Response(null, { status: 400 })
	const context = await dependencies.context(parsed.data)
	if (!context) return new Response(null, { status: 403 })
	await dependencies.emit(context, parsed.data)
	return new Response(null, { status: 204 })
}
