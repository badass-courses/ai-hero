import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { withSkill } from '@/server/with-skill'
import { getMultipartPartUrl } from '@/video-uploader/multipart-s3'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export const OPTIONS = async () => {
	return NextResponse.json({}, { headers: corsHeaders })
}

export const GET = withSkill(async (request: NextRequest) => {
	const { ability, user } = await getUserAbilityForRequest(request)

	if (ability.cannot('create', 'Content')) {
		return NextResponse.json(
			{ error: user ? 'Forbidden' : 'Unauthorized' },
			{ status: user ? 403 : 401, headers: corsHeaders },
		)
	}

	const searchParams = new URL(request.url).searchParams
	const key = searchParams.get('key')
	const uploadId = searchParams.get('uploadId')
	const partNumber = searchParams.get('partNumber')

	if (!key || !uploadId || !partNumber) {
		return NextResponse.json(
			{ error: 'Missing required params: key, uploadId, partNumber' },
			{ status: 400, headers: corsHeaders },
		)
	}

	try {
		const result = await getMultipartPartUrl({
			key,
			uploadId,
			partNumber: parseInt(partNumber, 10),
		})

		return NextResponse.json(result, { headers: corsHeaders })
	} catch (error) {
		return NextResponse.json(
			{ error: 'Internal Server Error' },
			{ status: 500, headers: corsHeaders },
		)
	}
})
