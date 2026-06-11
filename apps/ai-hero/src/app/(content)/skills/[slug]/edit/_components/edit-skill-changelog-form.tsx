'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ImageResourceUploader } from '@/components/image-uploader/image-resource-uploader'
import { useResource } from '@/components/resource-form/resource-context'
import { withResourceForm } from '@/components/resource-form/with-resource-form'
import type { SkillChangelog } from '@/lib/skill-changelog'
import { triggerSkillChangelogBroadcast } from '@/lib/skill-changelog-actions'
import { ImagePlusIcon, Loader2, Send, VideoIcon } from 'lucide-react'
import toast from 'react-hot-toast'

import { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import {
	Button,
	Form,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	Input,
	Tabs,
	TabsList,
	TabsTrigger,
} from '@coursebuilder/ui'

import StandaloneVideoResourceUploaderAndViewer from '../../../../posts/_components/standalone-video-resource-uploader-and-viewer'
import { skillChangelogFormConfig } from './skill-changelog-form-config'
import { SkillChangelogFormFields } from './skill-changelog-form-fields'

export type EditSkillChangelogFormProps = {
	resource: SkillChangelog
	videoResource?: VideoResource | null
}

const BODY_FIELD = 'fields.body'
const NEWSLETTER_FIELD = 'fields.newsletterCopy'

type ActiveBodyField = typeof BODY_FIELD | typeof NEWSLETTER_FIELD

export function EditSkillChangelogForm({
	resource,
	videoResource,
}: EditSkillChangelogFormProps) {
	const router = useRouter()
	const [activeBodyField, setActiveBodyField] =
		React.useState<ActiveBodyField>(BODY_FIELD)

	const SkillChangelogForm = withResourceForm<
		SkillChangelog,
		typeof skillChangelogFormConfig.schema
	>(
		(props) => (
			<SkillChangelogFormFields {...props} videoResource={videoResource} />
		),
		{
			...skillChangelogFormConfig,
			onSave: async (saved, hasNewSlug) => {
				if (hasNewSlug) {
					router.push(`/skills/${saved.fields?.slug}/edit`)
				}
			},
			customTools: [
				{
					id: 'images',
					icon: () => (
						<ImagePlusIcon strokeWidth={1.5} size={24} width={18} height={18} />
					),
					toolComponent: (
						<ImageResourceUploader
							key={'image-uploader'}
							belongsToResourceId={resource.id}
							uploadDirectory={`skill-changelog`}
						/>
					),
				},
				{
					id: 'videos',
					icon: () => (
						<VideoIcon strokeWidth={1.5} size={24} width={18} height={18} />
					),
					toolComponent: <StandaloneVideoResourceUploaderAndViewer />,
				},
			],
		},
	)

	return (
		<SkillChangelogForm
			resource={resource}
			bodyFieldName={activeBodyField}
			bodyPanelSlot={
				<div className="border-border border-b">
					<div className="flex items-center justify-between gap-2 px-5 py-3">
						<Tabs
							value={activeBodyField}
							onValueChange={(value) =>
								setActiveBodyField(value as ActiveBodyField)
							}
						>
							<TabsList>
								<TabsTrigger value={BODY_FIELD}>Body</TabsTrigger>
								<TabsTrigger value={NEWSLETTER_FIELD}>
									Newsletter (Kit)
								</TabsTrigger>
							</TabsList>
						</Tabs>
						{activeBodyField === NEWSLETTER_FIELD ? (
							<NewsletterBroadcastButton resourceId={resource.id} />
						) : null}
					</div>
					{activeBodyField === NEWSLETTER_FIELD ? (
						<NewsletterMetaFields resource={resource} />
					) : null}
				</div>
			}
		/>
	)
}

function NewsletterBroadcastButton({ resourceId }: { resourceId: string }) {
	const { resource } = useResource<SkillChangelog>()
	const [isTriggering, startTransition] = React.useTransition()

	const broadcastId = resource?.fields?.kitBroadcastId
	const isPublished = resource?.fields?.state === 'published'

	const handleClick = () => {
		startTransition(async () => {
			const result = await triggerSkillChangelogBroadcast(resourceId)
			if (result.ok) {
				toast.success(
					broadcastId
						? 'Newsletter update queued — Kit draft will refresh in a few seconds.'
						: 'Newsletter queued — Kit draft will appear in a few seconds.',
				)
			} else {
				toast.error(result.error)
			}
		})
	}

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={handleClick}
			disabled={isTriggering || !isPublished}
			className="flex items-center gap-1"
			title={
				!isPublished ? 'Publish the changelog before sending to Kit' : undefined
			}
		>
			{isTriggering ? (
				<Loader2 className="h-4 w-4 animate-spin" />
			) : (
				<Send className="h-4 w-4" />
			)}
			{broadcastId ? 'Resync to Kit' : 'Send to Kit'}
		</Button>
	)
}

function NewsletterMetaFields({ resource }: { resource: SkillChangelog }) {
	const { form } = useResource<SkillChangelog>()
	if (!form) return null

	const broadcastId = resource.fields.kitBroadcastId
	const broadcastCreatedAt = resource.fields.kitBroadcastCreatedAt
	const broadcastUpdatedAt = resource.fields.kitBroadcastUpdatedAt

	return (
		<Form {...form}>
			<div className="grid gap-4 px-5 pb-4">
				<p className="text-muted-foreground text-xs">
					{broadcastId
						? `Kit broadcast #${String(broadcastId)} · ${
								broadcastUpdatedAt
									? `updated ${new Date(broadcastUpdatedAt).toLocaleString()}`
									: broadcastCreatedAt
										? `created ${new Date(broadcastCreatedAt).toLocaleString()}`
										: 'created'
							}`
						: 'Not yet sent to Kit. Publish the changelog and click "Send to Kit" to create a draft.'}
				</p>
				<FormField
					control={form.control}
					name="fields.newsletterSubject"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-sm font-semibold">Subject</FormLabel>
							<FormDescription>
								Email subject line. Falls back to the changelog title if empty.
							</FormDescription>
							<Input {...field} value={field.value ?? ''} />
							<FormMessage />
						</FormItem>
					)}
				/>
				<FormField
					control={form.control}
					name="fields.newsletterPreviewText"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-sm font-semibold">
								Preview text
								<span className="text-muted-foreground ml-2 text-xs tabular-nums">
									({`${field.value?.length ?? '0'} / 200`})
								</span>
							</FormLabel>
							<FormDescription>
								Snippet shown next to the subject in inboxes.
							</FormDescription>
							<Input {...field} value={field.value ?? ''} maxLength={200} />
							<FormMessage />
						</FormItem>
					)}
				/>
			</div>
		</Form>
	)
}
