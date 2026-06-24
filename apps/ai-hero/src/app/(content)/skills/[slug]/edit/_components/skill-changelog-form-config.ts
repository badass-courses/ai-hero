import { ResourceFormConfig } from '@/components/resource-form/with-resource-form'
import {
	SkillChangelogSchema,
	type SkillChangelog,
	type SkillChangelogUpdate,
} from '@/lib/skill-changelog'
import {
	autoUpdateSkillChangelog,
	updateSkillChangelog,
} from '@/lib/skill-changelog-mutations'

export const skillChangelogFormConfig: ResourceFormConfig<
	SkillChangelog,
	typeof SkillChangelogSchema
> = {
	resourceType: 'skill-changelog',
	schema: SkillChangelogSchema,
	defaultValues: (resource?: SkillChangelog) => {
		if (!resource) {
			return {
				type: 'skill-changelog',
				fields: {
					title: '',
					slug: '',
					body: '',
					description: '',
					state: 'draft',
					visibility: 'unlisted',
					github: '',
					thumbnailTime: 0,
					newsletterSubject: '',
					newsletterPreviewText: '',
					newsletterCopy: '',
				},
				id: '',
				organizationId: null,
				createdAt: null,
				updatedAt: null,
				deletedAt: null,
				createdById: '',
				resources: [],
				createdByOrganizationMembershipId: null,
				tags: null,
			} as unknown as SkillChangelog
		}

		return {
			...resource,
			fields: {
				...resource.fields,
				title: resource.fields.title || '',
				slug: resource.fields.slug || '',
				body: resource.fields.body ?? '',
				description: resource.fields.description ?? '',
				state: resource.fields.state || 'draft',
				visibility: resource.fields.visibility || 'unlisted',
				github: resource.fields.github ?? '',
				thumbnailTime: resource.fields.thumbnailTime ?? 0,
				coverImage: resource.fields.coverImage,
				newsletterSubject: resource.fields.newsletterSubject ?? '',
				newsletterPreviewText: resource.fields.newsletterPreviewText ?? '',
				newsletterCopy: resource.fields.newsletterCopy ?? '',
			},
		}
	},
	getResourcePath: (slug?: string) => `/skills/${slug || ''}`,
	updateResource: async (resource, action = 'save') => {
		if (!resource.id || !resource.fields) {
			throw new Error('Invalid skill changelog data')
		}
		const update: SkillChangelogUpdate = {
			id: resource.id,
			fields: {
				title: resource.fields.title || '',
				slug: resource.fields.slug || '',
				body: resource.fields.body ?? '',
				description: resource.fields.description ?? '',
				state: resource.fields.state || 'draft',
				visibility: resource.fields.visibility || 'unlisted',
				github: resource.fields.github ?? '',
				thumbnailTime: resource.fields.thumbnailTime ?? 0,
				...(resource.fields.coverImage?.url
					? { coverImage: resource.fields.coverImage }
					: {}),
				newsletterSubject: resource.fields.newsletterSubject ?? null,
				newsletterPreviewText: resource.fields.newsletterPreviewText ?? null,
				newsletterCopy: resource.fields.newsletterCopy ?? null,
			},
		}
		return updateSkillChangelog(update, action)
	},
	autoUpdateResource: async (resource, action = 'save') => {
		if (!resource.id || !resource.fields) {
			throw new Error('Invalid skill changelog data')
		}
		const update: SkillChangelogUpdate = {
			id: resource.id,
			fields: {
				title: resource.fields.title || '',
				slug: resource.fields.slug || '',
				body: resource.fields.body ?? '',
				description: resource.fields.description ?? '',
				state: resource.fields.state || 'draft',
				visibility: resource.fields.visibility || 'unlisted',
				github: resource.fields.github ?? '',
				thumbnailTime: resource.fields.thumbnailTime ?? 0,
				...(resource.fields.coverImage?.url
					? { coverImage: resource.fields.coverImage }
					: {}),
				newsletterSubject: resource.fields.newsletterSubject ?? null,
				newsletterPreviewText: resource.fields.newsletterPreviewText ?? null,
				newsletterCopy: resource.fields.newsletterCopy ?? null,
			},
		}
		return action === 'save'
			? autoUpdateSkillChangelog(update)
			: updateSkillChangelog(update, action, false)
	},
	bodyPanelConfig: {
		showListResources: false,
	},
}
