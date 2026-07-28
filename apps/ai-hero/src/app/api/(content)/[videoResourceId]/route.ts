import { NextRequest, NextResponse } from 'next/server'
import { getVideoResource } from '@/lib/video-resource-query'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const getVideoResourceHandler = async (
	request: NextRequest,
	props: { params: Promise<{ videoResourceId: string }> },
) => {
	try {
		const params = await props.params
		const { ability, user } = await getUserAbilityForRequest(request)

		await log.info('api.video.get.started', {
			userId: user?.id,
			videoResourceId: params.videoResourceId,
			hasAbility: ability.can('create', 'Content'),
		})

		if (!params.videoResourceId) {
			await log.warn('api.video.get.invalid', {
				userId: user?.id,
				error: 'Missing videoResourceId',
			})
			return NextResponse.json({}, { headers: corsHeaders })
		}

		if (ability.cannot('create', 'Content')) {
			await log.warn('api.video.get.unauthorized', {
				userId: user?.id,
				videoResourceId: params.videoResourceId,
			})
			return NextResponse.json(
				{ error: user ? 'Forbidden' : 'Unauthorized', docs: '/api' },
				{
					status: user ? 403 : 401,
					headers: corsHeaders,
				},
			)
		}

		const videoResource = await getVideoResource(params.videoResourceId)

		if (!videoResource) {
			await log.warn('api.video.get.notfound', {
				userId: user?.id,
				videoResourceId: params.videoResourceId,
			})
			return NextResponse.json(
				{ error: 'videoResource not found' },
				{
					status: 404,
					headers: corsHeaders,
				},
			)
		}

		await log.info('api.video.get.success', {
			userId: user?.id,
			videoResourceId: params.videoResourceId,
			muxAssetId: videoResource.muxAssetId,
		})
		return NextResponse.json(videoResource, {
			headers: corsHeaders,
		})
	} catch (error) {
		await log.error('api.video.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
			videoResourceId: (await props.params).videoResourceId,
		})

		return NextResponse.json(
			{ error: 'Internal server error' },
			{
				status: 500,
				headers: corsHeaders,
			},
		)
	}
}
export const GET = withSkill(getVideoResourceHandler)
