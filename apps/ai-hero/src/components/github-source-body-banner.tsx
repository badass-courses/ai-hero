'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { syncGithubSourceNow } from '@/lib/github-source-actions'
import { Loader2, RefreshCw } from 'lucide-react'

import { Button, useToast } from '@coursebuilder/ui'

/**
 * Banner shown above the body editor when a post's body is synced from a GitHub
 * source. Makes the read-only state obvious (the editor alone doesn't say why)
 * and offers a one-click "Sync now" to re-pull without waiting for the cron or
 * a push.
 */
export function GithubSourceBodyBanner({
	postId,
	source,
}: {
	postId: string
	source: string
}) {
	const router = useRouter()
	const { toast } = useToast()
	const [isSyncing, setIsSyncing] = React.useState(false)

	const syncNow = async () => {
		setIsSyncing(true)
		try {
			const result = await syncGithubSourceNow(postId)
			if (result.status === 'error') {
				toast({
					title: 'Sync failed',
					description: result.reason ?? 'Please try again.',
					variant: 'destructive',
				})
			} else if (result.status === 'updated') {
				toast({ title: 'Body updated from source' })
				router.refresh()
			} else {
				toast({ title: `Nothing to sync (${result.status})` })
				// The DB body may already be current while a cached page is stale;
				// the action revalidated, so refresh to pick up the fresh render.
				router.refresh()
			}
		} catch (error) {
			toast({
				title: 'Sync failed',
				description: error instanceof Error ? error.message : 'Please try again.',
				variant: 'destructive',
			})
		} finally {
			setIsSyncing(false)
		}
	}

	return (
		<div className="border-b bg-muted/40 flex flex-wrap items-center justify-between gap-3 px-5 py-3">
			<p className="text-muted-foreground min-w-0 text-sm">
				<span className="text-foreground font-medium">Synced from GitHub</span> —
				this body is read-only. Edit it in{' '}
				<span className="text-foreground break-all font-mono text-xs">
					{source}
				</span>
				. Changes made here are overwritten on the next sync.
			</p>
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={syncNow}
				disabled={isSyncing}
				className="shrink-0"
			>
				{isSyncing ? (
					<Loader2 className="size-4 animate-spin" aria-hidden="true" />
				) : (
					<RefreshCw className="size-4" aria-hidden="true" />
				)}
				Sync now
			</Button>
		</div>
	)
}
