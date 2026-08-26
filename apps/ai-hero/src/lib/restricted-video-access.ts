import { z } from 'zod'

/**
 * A videoResource that only one organization's members may watch.
 *
 * The restriction lives in the resource's `fields` JSON blob as
 * `restrictedToOrganizationId`, so no migration is involved and an ordinary
 * videoResource stays exactly what it was. A resource WITHOUT that key is not
 * a restricted video, and this module refuses to describe it — see
 * `resolveRestrictedVideoAccess` for why that matters.
 */
export const RESTRICTION_FIELD = 'restrictedToOrganizationId' as const

const RestrictedVideoFieldsSchema = z.object({
	[RESTRICTION_FIELD]: z.string().trim().min(1),
	muxPlaybackId: z.string().trim().min(1).nullish(),
	title: z.string().nullish(),
	duration: z.number().nullish(),
})

/**
 * The ONLY shape that reaches the browser. No mux asset id, no transcript, no
 * organization id — a viewer who is allowed to watch learns nothing about who
 * else is.
 */
export type RestrictedVideoPayload = {
	playbackId: string
	title: string | null
	duration: number | null
}

export type RestrictedVideoDenialReason =
	/** The resource carries no restriction, so this endpoint will not serve it. */
	| 'not-restricted'
	/** Signed out, or signed in without a role in the owning organization. */
	| 'not-a-member'
	/** Restricted and permitted, but Mux has not produced a playback id yet. */
	| 'not-ready'

export type RestrictedVideoAccess =
	| { status: 'ok'; video: RestrictedVideoPayload }
	| { status: 'not-found' }
	| { status: 'denied'; reason: RestrictedVideoDenialReason }

/**
 * The row this decision is made from. Deliberately the RAW content resource
 * rather than `courseBuilderAdapter.getVideoResource`, whose SQL hand-picks
 * columns out of `fields` and whose zod schema strips anything it does not
 * name — the restriction key would never survive the trip.
 */
export type RestrictedVideoResourceRow = {
	id: string
	type: string | null
	fields: unknown
} | null

export type OrganizationRole = {
	organizationId?: string | null
}

/**
 * Decide whether this viewer may watch this video, and what they get told.
 *
 * ## Why an absent restriction is a refusal, not a pass
 *
 * The obvious reading of "restricted to org X" is that a video without the key
 * is unrestricted and therefore fine to hand out. That would turn this route
 * into a playback-id oracle for every videoResource in the database: every
 * lesson, every solution, every unpublished draft, keyed by an id that is not
 * a secret. So the absence of the field is a `denied`, and the endpoint serves
 * exactly one kind of resource — the kind that was deliberately marked.
 *
 * ## Why membership is checked before readiness
 *
 * A non-member gets the same `denied` whether or not Mux has finished
 * encoding, so the response cannot be used to probe the state of a video the
 * caller has no business knowing about.
 */
export function resolveRestrictedVideoAccess({
	resource,
	organizationRoles,
	isAdmin = false,
}: {
	resource: RestrictedVideoResourceRow
	organizationRoles: OrganizationRole[] | null | undefined
	isAdmin?: boolean
}): RestrictedVideoAccess {
	if (!resource || resource.type !== 'videoResource') {
		return { status: 'not-found' }
	}

	const parsed = RestrictedVideoFieldsSchema.safeParse(resource.fields)

	if (!parsed.success) {
		return { status: 'denied', reason: 'not-restricted' }
	}

	const organizationId = parsed.data[RESTRICTION_FIELD]
	const isMember = (organizationRoles ?? []).some(
		(role) => role?.organizationId === organizationId,
	)

	if (!(isMember || isAdmin)) {
		return { status: 'denied', reason: 'not-a-member' }
	}

	const playbackId = parsed.data.muxPlaybackId

	if (!playbackId) {
		return { status: 'denied', reason: 'not-ready' }
	}

	return {
		status: 'ok',
		video: {
			playbackId,
			title: parsed.data.title ?? null,
			duration: parsed.data.duration ?? null,
		},
	}
}
