import { NextRequest, NextResponse } from 'next/server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { withSkill } from '@/server/with-skill'
import { getSignedUrlForVideoFile } from '@/video-uploader/get-signed-s3-url'

export const GET = withSkill(async (request: NextRequest) => {
	const { ability, user } = await getUserAbilityForRequest(request)
	if (ability.cannot('create', 'Content')) {
		return NextResponse.json(
			{ error: user ? 'Forbidden' : 'Unauthorized' },
			{
				status: user ? 403 : 401,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization',
				},
			},
		)
	}

	const searchParams = new URL(request.url).searchParams
	const filename = searchParams.get('objectName')

	if (filename) {
		const signedUrl = await getSignedUrlForVideoFile({ filename })
		return NextResponse.json(signedUrl, {
			status: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			},
		})
	}

	return NextResponse.json(
		{ error: 'No filename provided' },
		{
			status: 400,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			},
		},
	)
})
