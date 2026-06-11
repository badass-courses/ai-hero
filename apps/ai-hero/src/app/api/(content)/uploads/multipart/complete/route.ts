import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { withSkill } from '@/server/with-skill'
import { completeMultipartUpload } from '@/video-uploader/multipart-s3'
import { z } from 'zod'

const CompleteSchema = z.object({
	key: z.string().min(1),
	uploadId: z.string().min(1),
	parts: z.array(
		z.object({
			partNumber: z.number().int().positive(),
			etag: z.string().min(1),
		}),
	),
})

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = async () => {
	return NextResponse.json({}, { headers: corsHeaders })
}

export const POST = withSkill(async (request: NextRequest) => {
	const { ability } = await getUserAbilityForRequest(request)

	if (ability.cannot('create', 'Content')) {
		return NextResponse.json(
			{ error: 'Unauthorized' },
			{ status: 401, headers: corsHeaders },
		)
	}

	try {
		const body = await request.json()
		const validated = CompleteSchema.parse(body)
		const result = await completeMultipartUpload(validated)

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ error: error.errors },
				{ status: 400, headers: corsHeaders },
			)
		}
		return NextResponse.json(
			{ error: 'Internal Server Error' },
			{ status: 500, headers: corsHeaders },
		)
	}
})
