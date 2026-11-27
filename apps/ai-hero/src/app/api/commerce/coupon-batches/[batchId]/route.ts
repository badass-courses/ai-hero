import { handlers } from '../handlers'

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ batchId: string }> },
) {
	return handlers.status(request, (await params).batchId)
}
