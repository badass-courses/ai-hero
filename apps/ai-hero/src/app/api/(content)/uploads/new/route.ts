import { NextRequest, NextResponse } from 'next/server'
import { inngest } from '@/inngest/inngest.server'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log, serializeError } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { z } from 'zod'

import { VIDEO_UPLOADED_EVENT } from '@coursebuilder/core/inngest/video-processing/events/event-video-uploaded'

// Zod schema for the request body
const UploadBodySchema = z.object({
	file: z.object({
		url: z.string().url(),
		name: z.string().optional(),
	}),
	metadata: z.object({
		parentResourceId: z.string(),
	}),
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
	const { user, ability } = await getUserAbilityForRequest(request)

	if (ability.cannot('create', 'Content')) {
		return NextResponse.json(
			{ error: 'Unauthorized' },
			{ status: 401, headers: corsHeaders },
		)
	}

	let body: unknown
	try {
		body = await request.json()
	} catch (error) {
		await log.warn('uploads.new.body_parse_failed', {
			userId: user?.id,
			error: serializeError(error),
		})
		return NextResponse.json(
			{ error: 'Invalid JSON body' },
			{ status: 400, headers: corsHeaders },
		)
	}

	const parsed = UploadBodySchema.safeParse(body)
	if (!parsed.success) {
		const bodyKeys =
			body && typeof body === 'object' && !Array.isArray(body)
				? Object.keys(body as Record<string, unknown>)
				: []
		const metadataKeys =
			body &&
			typeof body === 'object' &&
			'metadata' in (body as Record<string, unknown>) &&
			(body as Record<string, unknown>).metadata &&
			typeof (body as Record<string, unknown>).metadata === 'object'
				? Object.keys(
						(body as Record<string, unknown>).metadata as Record<
							string,
							unknown
						>,
					)
				: []
		await log.warn('uploads.new.validation_failed', {
			userId: user?.id,
			issues: parsed.error.issues,
			bodyKeys,
			metadataKeys,
		})
		return NextResponse.json(
			{ error: parsed.error.issues },
			{ status: 400, headers: corsHeaders },
		)
	}

	try {
		await inngest.send({
			name: VIDEO_UPLOADED_EVENT,
			data: {
				originalMediaUrl: parsed.data.file.url,
				fileName: parsed.data.file.name || 'untitled',
				title: parsed.data.file.name || 'untitled',
				parentResourceId: parsed.data.metadata.parentResourceId,
			},
			user,
		})

		return NextResponse.json({ success: true }, { headers: corsHeaders })
	} catch (error) {
		await log.error('uploads.new.inngest_send_failed', {
			userId: user?.id,
			parentResourceId: parsed.data.metadata.parentResourceId,
			error: serializeError(error),
		})
		return NextResponse.json(
			{ error: 'Internal Server Error' },
			{ status: 500, headers: corsHeaders },
		)
	}
})
