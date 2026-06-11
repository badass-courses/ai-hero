import { z } from 'zod'
import {
	DEFAULT_YOUTUBE_LIVE_THUMBNAIL_URL,
	type CreateYouTubeLiveBroadcastInput,
	type YouTubeLiveBroadcast,
	type YouTubeLiveBroadcastStatus,
	type YouTubeLiveStream,
	type UpdateYouTubeLiveBroadcastInput,
} from '@/lib/youtube-live-broadcasts'

export const CREATE_YOUTUBE_BROADCAST_CONFIRMATION = 'CREATE_YOUTUBE_BROADCAST'
export const UPDATE_YOUTUBE_BROADCAST_CONFIRMATION = 'UPDATE_YOUTUBE_BROADCAST'

export const YouTubeLiveBroadcastStatusSchema = z.enum([
	'active',
	'all',
	'completed',
	'upcoming',
]) satisfies z.ZodType<YouTubeLiveBroadcastStatus>

export const YouTubeLivePrivacyStatusSchema = z.enum([
	'private',
	'public',
	'unlisted',
])

const IsoUtcDateTimeSchema = z
	.string()
	.datetime()
	.refine((value) => value.endsWith('Z'), {
		message: 'Use an ISO UTC timestamp ending in Z',
	})

const OptionalStringSchema = z
	.string()
	.transform((value) => value.trim())
	.pipe(z.string().min(1))
	.optional()

export const YouTubeLiveBroadcastCreateBodySchema = z
	.object({
		title: z.string().trim().min(1).max(100),
		description: z.string().max(5000).optional().default(''),
		scheduledStartTime: IsoUtcDateTimeSchema,
		scheduledEndTime: IsoUtcDateTimeSchema.optional(),
		privacyStatus:
			YouTubeLivePrivacyStatusSchema.optional().default('unlisted'),
		streamId: OptionalStringSchema,
		thumbnailUrl: z
			.string()
			.url()
			.optional()
			.default(DEFAULT_YOUTUBE_LIVE_THUMBNAIL_URL),
		confirm: z.string().optional(),
	})
	.superRefine((input, ctx) => {
		if (!input.scheduledEndTime) return

		if (
			new Date(input.scheduledEndTime).getTime() <=
			new Date(input.scheduledStartTime).getTime()
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['scheduledEndTime'],
				message: 'scheduledEndTime must be after scheduledStartTime',
			})
		}
	})

export const YouTubeLiveBroadcastUpdateBodySchema = z
	.object({
		title: z.string().trim().min(1).max(100).optional(),
		description: z.string().max(5000).optional(),
		scheduledStartTime: IsoUtcDateTimeSchema.optional(),
		scheduledEndTime: IsoUtcDateTimeSchema.optional(),
		privacyStatus: YouTubeLivePrivacyStatusSchema.optional(),
		confirm: z.string().optional(),
	})
	.superRefine((input, ctx) => {
		const changedKeys = [
			'title',
			'description',
			'scheduledStartTime',
			'scheduledEndTime',
			'privacyStatus',
		].filter((key) => input[key as keyof typeof input] !== undefined)

		if (changedKeys.length === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'At least one broadcast field is required',
			})
		}

		if (input.scheduledStartTime && input.scheduledEndTime) {
			if (
				new Date(input.scheduledEndTime).getTime() <=
				new Date(input.scheduledStartTime).getTime()
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['scheduledEndTime'],
					message: 'scheduledEndTime must be after scheduledStartTime',
				})
			}
		}
	})

export type YouTubeLiveBroadcastCreateBody = z.infer<
	typeof YouTubeLiveBroadcastCreateBodySchema
>
export type YouTubeLiveBroadcastUpdateBody = z.infer<
	typeof YouTubeLiveBroadcastUpdateBodySchema
>

export function requireCreateConfirmation(
	body: Pick<YouTubeLiveBroadcastCreateBody, 'confirm'>,
) {
	return body.confirm === CREATE_YOUTUBE_BROADCAST_CONFIRMATION
}

export function requireUpdateConfirmation(
	body: Pick<YouTubeLiveBroadcastUpdateBody, 'confirm'>,
) {
	return body.confirm === UPDATE_YOUTUBE_BROADCAST_CONFIRMATION
}

export function toCreateYouTubeLiveBroadcastInput(
	body: YouTubeLiveBroadcastCreateBody,
): CreateYouTubeLiveBroadcastInput {
	return {
		title: body.title,
		description: body.description,
		scheduledStartTime: body.scheduledStartTime,
		...(body.scheduledEndTime
			? { scheduledEndTime: body.scheduledEndTime }
			: {}),
		privacyStatus: body.privacyStatus,
		...(body.streamId ? { streamId: body.streamId } : {}),
		...(body.thumbnailUrl ? { thumbnailUrl: body.thumbnailUrl } : {}),
	}
}

export function toUpdateYouTubeLiveBroadcastInput(
	id: string,
	body: YouTubeLiveBroadcastUpdateBody,
): UpdateYouTubeLiveBroadcastInput {
	return {
		id,
		...(body.title !== undefined ? { title: body.title } : {}),
		...(body.description !== undefined
			? { description: body.description }
			: {}),
		...(body.scheduledStartTime !== undefined
			? { scheduledStartTime: body.scheduledStartTime }
			: {}),
		...(body.scheduledEndTime !== undefined
			? { scheduledEndTime: body.scheduledEndTime }
			: {}),
		...(body.privacyStatus !== undefined
			? { privacyStatus: body.privacyStatus }
			: {}),
	}
}

export type YouTubeLiveBroadcastReceipt = Omit<YouTubeLiveBroadcast, 'raw'>

export function toYouTubeLiveBroadcastReceipt(
	broadcast: YouTubeLiveBroadcast,
): YouTubeLiveBroadcastReceipt {
	const { raw: _raw, ...receipt } = broadcast
	return receipt
}

export function buildCreatePreview(
	body: YouTubeLiveBroadcastCreateBody,
	stream: YouTubeLiveStream | null,
) {
	return {
		willCreate: true,
		requiresConfirmation: CREATE_YOUTUBE_BROADCAST_CONFIRMATION,
		payload: toCreateYouTubeLiveBroadcastInput(body),
		stream: stream
			? {
					id: stream.id,
					title: stream.title,
					streamStatus: stream.streamStatus,
					healthStatus: stream.healthStatus,
				}
			: null,
	}
}

export function getEffectiveUpdateTimes(
	body: YouTubeLiveBroadcastUpdateBody,
	current: YouTubeLiveBroadcast,
) {
	return {
		scheduledStartTime:
			body.scheduledStartTime ?? current.scheduledStartTime ?? null,
		scheduledEndTime: body.scheduledEndTime ?? current.scheduledEndTime ?? null,
	}
}

export function validateEffectiveUpdateTimes(
	body: YouTubeLiveBroadcastUpdateBody,
	current: YouTubeLiveBroadcast,
) {
	const { scheduledStartTime, scheduledEndTime } = getEffectiveUpdateTimes(
		body,
		current,
	)

	if (!scheduledStartTime || !scheduledEndTime) return true

	return (
		new Date(scheduledEndTime).getTime() >
		new Date(scheduledStartTime).getTime()
	)
}

export function buildUpdatePreview(
	id: string,
	body: YouTubeLiveBroadcastUpdateBody,
	current: YouTubeLiveBroadcast,
) {
	return {
		willUpdate: true,
		requiresConfirmation: UPDATE_YOUTUBE_BROADCAST_CONFIRMATION,
		id,
		current: toYouTubeLiveBroadcastReceipt(current),
		payload: toUpdateYouTubeLiveBroadcastInput(id, body),
		effectiveTimes: getEffectiveUpdateTimes(body, current),
	}
}
