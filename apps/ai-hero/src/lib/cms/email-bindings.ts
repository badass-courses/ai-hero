import type { Email } from '@/lib/emails'
import { EmailSchema } from '@/lib/emails'
import { updateEmail } from '@/lib/emails-query'
import { z } from 'zod'

import type {
	ResourceAction,
	ResourceBindings,
} from '@coursebuilder/ui/cms/manifest'
import { stripClientPublishedAt } from '@coursebuilder/ui/cms/resource-state'

import { listImageMediaAssets, uploadToCloudinary } from './post-bindings'

/**
 * Editor-side schema for the email cms editor. Identical to `EmailSchema`
 * except `fields.subject`: the server schema is `z.string().min(2).nullish()`,
 * but a controlled input yields `''` when cleared — which fails `min(2)` and
 * would silently block every save. Preprocess normalizes empty/whitespace
 * input back to `null` (the schema's own "no subject" value; broadcast sends
 * fall back to a title-derived subject). Server validation is untouched.
 */
export const EmailEditorSchema = EmailSchema.merge(
	z.object({
		fields: EmailSchema.shape.fields.extend({
			subject: z.preprocess(
				(value) =>
					typeof value === 'string' && value.trim() === '' ? null : value,
				z.string().min(2).max(90).nullish(),
			),
		}),
	}),
)

/**
 * Server bindings for the cms email editor (`createResourceEditor`).
 *
 * Mirrors `createPostBindings`: verbs map 1:1 onto the server actions the
 * legacy `EditEmailsForm` used — `updateEmail` (single-arg upsert, no action
 * param) for saves, and the shared Cloudinary pipeline for the Media tab.
 *
 * FIX (long-standing copy-paste bug): the legacy form's image tool uploaded
 * email images to Cloudinary dir `workshops`. The Media tab now uploads to
 * `emails/{emailId}` — the email's own per-resource folder, matching the
 * `posts/{postId}` convention every other type uses.
 */
export interface CreateEmailBindingsOptions {
	/** The email's id — scopes Cloudinary uploads to `emails/{id}`. */
	resourceId: string
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the reference forms: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb
 * (`updateEmail` has no action param — state is just a field).
 */
function stateForAction(
	action: ResourceAction,
	current: Email['fields']['state'],
): Email['fields']['state'] {
	switch (action) {
		case 'publish':
			return 'published'
		case 'archive':
			return 'archived'
		case 'unpublish':
			return 'draft'
		default:
			return current
	}
}

export function createEmailBindings({
	resourceId,
	onSlugChange,
}: CreateEmailBindingsOptions): ResourceBindings<typeof EmailEditorSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			// updateEmail never regenerates the slug on title change — only an
			// explicit slug edit (or the client-side "From title" button) changes
			// it, matching the posts policy.
			const updated = await updateEmail({
				...values,
				fields: {
					...stripClientPublishedAt(values.fields),
					state: stateForAction(action, values.fields.state || 'draft'),
				},
			})
			// null here means nothing was persisted — don't let the kit report 'Saved'.
			if (updated == null) {
				throw new Error('Email save failed — nothing was persisted')
			}
			return updated
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		// Legacy parity: the old form used `/${slug}` too. Emails have no public
		// page there — the action bar's View link is as dubious as it always was;
		// fixing it means giving emails a real preview route (out of scope).
		getResourcePath: (slug) => `/${slug || ''}`,
		media: {
			// THE FIX: `emails/{id}`, not the legacy copy-pasted `workshops` dir.
			upload: (file) => uploadToCloudinary(file, `emails/${resourceId}`),
			// Same primitive DB-backed image library the post editor lists.
			list: listImageMediaAssets,
		},
		// No video bindings: email bodies are broadcast-pipeline MDX, not site
		// MDX — a `<Video>` inserter would store markup emails cannot render.
	}
}
