import * as React from 'react'
import { ResourceFormProps } from '@/components/resource-form/with-resource-form'
import { updateSkillChangelog } from '@/lib/skill-changelog-mutations'
import {
	SkillChangelogSchema,
	type SkillChangelog,
} from '@/lib/skill-changelog'

import { VideoResource } from '@coursebuilder/core/schemas'
import {
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	Textarea,
} from '@coursebuilder/ui'
import { MetadataFieldState } from '@coursebuilder/ui/resources-crud/metadata-fields/metadata-field-state'
import { MetadataFieldVisibility } from '@coursebuilder/ui/resources-crud/metadata-fields/metadata-field-visibility'

import { VideoResourceField } from '../../../../posts/_components/video-resource-field'

export function SkillChangelogFormFields({
	form,
	resource,
	videoResource,
	videoResourceId,
}: ResourceFormProps<SkillChangelog, typeof SkillChangelogSchema> & {
	videoResource?: VideoResource | null
	videoResourceId?: string | null
}) {
	if (!form) return null

	return (
		<>
			<VideoResourceField
				form={form}
				post={resource as any}
				videoResource={videoResource ?? null}
				initialVideoResourceId={videoResourceId ?? null}
				onVideoUpdate={async (_resourceId, _videoResourceId, additionalFields) => {
					const fields = form.getValues('fields')
					await updateSkillChangelog(
						{
							id: resource.id,
							fields: {
								title: fields.title || resource.fields.title || '',
								slug: fields.slug || resource.fields.slug || '',
								body: fields.body ?? '',
								description: fields.description ?? '',
								state: fields.state || resource.fields.state || 'draft',
								visibility:
									fields.visibility || resource.fields.visibility || 'unlisted',
								github: fields.github ?? '',
								thumbnailTime:
									additionalFields.thumbnailTime ?? fields.thumbnailTime ?? null,
								...(fields.coverImage?.url
									? { coverImage: fields.coverImage }
									: {}),
								newsletterSubject: fields.newsletterSubject ?? null,
								newsletterPreviewText: fields.newsletterPreviewText ?? null,
								newsletterCopy: fields.newsletterCopy ?? null,
							},
						},
						'save',
					)
				}}
			/>
			<FormField
				control={form.control}
				name="fields.title"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">Title</FormLabel>
						<Input {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
			<FormField
				control={form.control}
				name="fields.slug"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">Slug</FormLabel>
						<FormDescription>
							Renders at <code>/skills/{field.value || '<slug>'}</code>.
						</FormDescription>
						<Input {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
			<FormField
				control={form.control}
				name="fields.description"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">
							SEO Description
							<br />
							<span className="text-muted-foreground text-sm tabular-nums">
								({`${field.value?.length ?? '0'} / 160`})
							</span>
						</FormLabel>
						<FormDescription>
							A short summary, ideally under 160 characters.
						</FormDescription>
						<Textarea rows={3} {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
			<MetadataFieldVisibility form={form} />
			<MetadataFieldState form={form} />
			<FormField
				control={form.control}
				name="fields.github"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">GitHub link</FormLabel>
						<Input {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
			<FormField
				control={form.control}
				name="fields.coverImage.url"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">Cover image URL</FormLabel>
						<Input {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
			<FormField
				control={form.control}
				name="fields.coverImage.alt"
				render={({ field }) => (
					<FormItem className="px-5">
						<FormLabel className="text-lg font-bold">
							Cover image alt text
						</FormLabel>
						<Input {...field} value={field.value ?? ''} />
						<FormMessage />
					</FormItem>
				)}
			/>
		</>
	)
}
