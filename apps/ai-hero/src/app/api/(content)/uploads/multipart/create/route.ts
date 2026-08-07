import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { canUploadMedia } from '@/server/pat-scopes'
import { withSkill } from '@/server/with-skill'
import { CreateMultipartUploadSchema } from '@/video-uploader/multipart-contracts'
import { createMultipartUpload } from '@/video-uploader/multipart-s3'
import { z } from 'zod'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = async () => {
	return NextResponse.json({}, { headers: corsHeaders })
}

export const POST = withSkill(async (request: NextRequest) => {
	const { ability, user } = await getUserAbilityForRequest(request)

	if (!canUploadMedia(ability)) {
		return NextResponse.json(
			{ error: user ? 'Forbidden' : 'Unauthorized', docs: '/api' },
			{ status: user ? 403 : 401, headers: corsHeaders },
		)
	}

	try {
		const body = await request.json()
		const { filename } = CreateMultipartUploadSchema.parse(body)
		const result = await createMultipartUpload({ filename })

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json(
				{ error: error.issues },
				{ status: 400, headers: corsHeaders },
			)
		}
		return NextResponse.json(
			{ error: 'Internal Server Error' },
			{ status: 500, headers: corsHeaders },
		)
	}
})
