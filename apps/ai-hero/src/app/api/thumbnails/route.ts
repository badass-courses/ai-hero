// get mux thumbnail

import { NextRequest, NextResponse } from 'next/server'
import { getVideoResource } from '@/lib/video-resource-query'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'

/**
 * Widths a caller may ask for: the lesson poster's default, and /videos cards.
 * An allowlist, so the proxy cannot be driven to fetch arbitrary variants.
 */
const THUMBNAIL_WIDTHS = new Set(['320', '720'])

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export async function OPTIONS() {
	return NextResponse.json({}, { headers: corsHeaders })
}

const getThumbnailHandler = async (request: NextRequest) => {
	try {
		const { searchParams } = new URL(request.url)
		// const searchParams = request.nextUrl.searchParams
		const videoResourceId = searchParams.get('videoResourceId')
		const time = searchParams.get('time')
		const requestedWidth = searchParams.get('width') ?? '320'
		const width = THUMBNAIL_WIDTHS.has(requestedWidth) ? requestedWidth : '320'
		const params = { videoResourceId }
		if (!params.videoResourceId) {
			return NextResponse.json(
				{ error: 'Missing videoResourceId' },
				{ status: 400, headers: corsHeaders },
			)
		}

		const videoResource = await getVideoResource(params.videoResourceId)
		if (!videoResource) {
			return NextResponse.json(
				{ error: 'videoResource not found' },
				{ status: 404, headers: corsHeaders },
			)
		}

		// fields is where muxPlaybackId and thumbnailTime live
		const fields = (videoResource as any).fields || {}
		const muxPlaybackId = videoResource.muxPlaybackId
		if (!muxPlaybackId) {
			return NextResponse.json(
				{ error: 'No Mux playback ID found' },
				{ status: 404, headers: corsHeaders },
			)
		}
		const thumbnailTime = time || fields.thumbnailTime || 0
		const thumbnailUrl = `https://image.mux.com/${muxPlaybackId}/thumbnail.png?time=${thumbnailTime}&width=${width}`

		const thumbnailResponse = await fetch(thumbnailUrl)
		if (!thumbnailResponse.ok) {
			await log.error('api.thumbnail.get.muxerror', {
				videoResourceId: params.videoResourceId,
				muxPlaybackId,
				status: thumbnailResponse.status,
			})
			return NextResponse.json(
				{ error: 'Failed to fetch thumbnail from Mux' },
				{ status: 500, headers: corsHeaders },
			)
		}

		const imageBuffer = await thumbnailResponse.arrayBuffer()
		return new NextResponse(imageBuffer, {
			headers: {
				'Content-Type': 'image/png',
				'Cache-Control': 'public, max-age=31536000, immutable', // Cache for 1 year since thumbnails rarely change
				...corsHeaders,
			},
		})
	} catch (error) {
		await log.error('api.thumbnail.get.failed', {
			error: error instanceof Error ? error.message : 'Unknown error',
			stack: error instanceof Error ? error.stack : undefined,
		})
		return NextResponse.json(
			{ error: 'Internal server error' },
			{ status: 500, headers: corsHeaders },
		)
	}
}
export const GET = withSkill(getThumbnailHandler)
