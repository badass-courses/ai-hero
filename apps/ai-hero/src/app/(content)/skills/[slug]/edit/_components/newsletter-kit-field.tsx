'use client'

import * as React from 'react'
import type { SkillChangelog } from '@/lib/skill-changelog'
import { triggerSkillChangelogBroadcast } from '@/lib/skill-changelog-actions'
import { Loader2, Send } from 'lucide-react'
import toast from 'react-hot-toast'

import { Button } from '@coursebuilder/ui'
import type { EditorCtx } from '@coursebuilder/ui/cms/manifest'

/**
 * Newsletter-tab `custom` field for the cms skill-changelog editor: the Kit
 * broadcast status line + "Send to Kit" / "Resync to Kit" button. Direct port
 * of the legacy `NewsletterBroadcastButton` + broadcast status text from
 * `edit-skill-changelog-form.tsx` — same server action
 * (`triggerSkillChangelogBroadcast`), same published-only gating, same toasts.
 * Lives app-side because it closes over an app server action (the manifest's
 * escape-hatch contract).
 */
export function NewsletterKitField({ ctx }: { ctx: EditorCtx }) {
	const resource = ctx.resource as SkillChangelog
	const [isTriggering, startTransition] = React.useTransition()

	const broadcastId = resource?.fields?.kitBroadcastId
	const broadcastCreatedAt = resource?.fields?.kitBroadcastCreatedAt
	const broadcastUpdatedAt = resource?.fields?.kitBroadcastUpdatedAt

	// Live form state (the publish chip writes `fields.state`), falling back to
	// the loaded resource — matches the legacy gate (`state === 'published'`).
	const state =
		(ctx.form.watch('fields.state' as never) as unknown as string) ??
		resource?.fields?.state
	const isPublished = state === 'published'

	const handleClick = () => {
		startTransition(async () => {
			const result = await triggerSkillChangelogBroadcast(resource.id)
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
		<div className="space-y-2">
			<p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
				Kit broadcast
			</p>
			<p className="text-muted-foreground text-[11px]">
				{broadcastId
					? `Kit broadcast #${String(broadcastId)} · ${
							broadcastUpdatedAt
								? `updated ${new Date(broadcastUpdatedAt).toLocaleString()}`
								: broadcastCreatedAt
									? `created ${new Date(broadcastCreatedAt).toLocaleString()}`
									: 'created'
						}`
					: 'Not yet sent to Kit. Publish the changelog, then send it as a Kit draft.'}
			</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={handleClick}
				disabled={isTriggering || !isPublished}
				className="flex items-center gap-1 text-[13px]"
				title={
					!isPublished
						? 'Publish the changelog before sending to Kit'
						: undefined
				}
			>
				{isTriggering ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : (
					<Send className="h-4 w-4" />
				)}
				{broadcastId ? 'Resync to Kit' : 'Send to Kit'}
			</Button>
		</div>
	)
}
