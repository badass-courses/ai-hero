'use client'

import * as React from 'react'
import { createAppAbility } from '@/ability'
import { env } from '@/env.mjs'
import { getOrCreateShortlinkForPage } from '@/lib/shortlinks-query'
import { api } from '@/trpc/react'
import { Link2, Loader2 } from 'lucide-react'

import { Button, useToast } from '@coursebuilder/ui'

/**
 * Admin-only control rendered inside the share dialog. Lets an admin mint a
 * shortlink for the current page in one click (with an optional custom slug)
 * and copies the resulting `/s/<slug>` URL to the clipboard. Renders nothing
 * for non-admins.
 */
export function AdminShortlinkCreator({ url }: { url: string }) {
	const { data: abilityRules, status } =
		api.ability.getCurrentAbilityRules.useQuery()
	const ability = createAppAbility(abilityRules || [])
	const isAdmin = status === 'success' && ability.can('manage', 'all')

	const { toast } = useToast()
	const [slugInput, setSlugInput] = React.useState('')
	const [shortUrl, setShortUrl] = React.useState<string | null>(null)
	const [isCreating, setIsCreating] = React.useState(false)
	const [copied, setCopied] = React.useState(false)

	if (!isAdmin) {
		return null
	}

	const copy = async (value: string) => {
		// Handle clipboard failures here so a copy error is never mistaken for a
		// shortlink-creation failure by the caller's catch block.
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			toast({ title: 'Copied short link' })
			window.setTimeout(() => setCopied(false), 1500)
		} catch {
			toast({
				title: 'Could not copy short link',
				description: 'The link was created — copy it manually.',
				variant: 'destructive',
			})
		}
	}

	const createShortlink = async () => {
		setIsCreating(true)
		try {
			const link = await getOrCreateShortlinkForPage({
				url,
				slug: slugInput.trim() || undefined,
			})
			const full = `${env.NEXT_PUBLIC_URL}/s/${link.slug}`
			setShortUrl(full)
			await copy(full)
		} catch (error) {
			toast({
				title: 'Could not create short link',
				description:
					error instanceof Error ? error.message : 'Please try again.',
				variant: 'destructive',
			})
		} finally {
			setIsCreating(false)
		}
	}

	return (
		<div className="flex flex-col gap-2 border-t pt-4">
			<span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
				Admin · Short link
			</span>
			{shortUrl ? (
				<div className="bg-background flex min-w-0 items-center gap-3 rounded-full border p-2 pl-4">
					<input
						readOnly
						value={shortUrl}
						aria-label="Short link"
						className="selection:bg-primary selection:text-primary-foreground min-w-0 flex-1 truncate bg-transparent text-sm outline-none sm:text-base"
						onFocus={(event) => event.currentTarget.select()}
						onClick={(event) => event.currentTarget.select()}
					/>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="shrink-0 rounded-full"
						onClick={() => copy(shortUrl)}
					>
						{copied ? 'Copied' : 'Copy'}
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-2">
					<div className="bg-background flex min-w-0 flex-1 items-center rounded-full border p-2 pl-4">
						<span className="text-muted-foreground shrink-0 text-sm">/s/</span>
						<input
							value={slugInput}
							onChange={(event) => setSlugInput(event.target.value)}
							placeholder="custom slug (optional)"
							aria-label="Custom short link slug"
							className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
							onKeyDown={(event) => {
								if (event.key === 'Enter' && !isCreating) {
									void createShortlink()
								}
							}}
						/>
					</div>
					<Button
						type="button"
						size="sm"
						className="shrink-0 rounded-full"
						onClick={createShortlink}
						disabled={isCreating}
					>
						{isCreating ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : (
							<Link2 className="size-4" aria-hidden="true" />
						)}
						Create short link
					</Button>
				</div>
			)}
		</div>
	)
}
