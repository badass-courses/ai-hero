'use client'

import { useState } from 'react'
import { Check, Copy, Linkedin } from 'lucide-react'

export function CertificateShareActions({
	permalink,
	courseName,
}: {
	permalink: string
	courseName: string
}) {
	const [copied, setCopied] = useState(false)
	const xUrl = new URL('https://twitter.com/intent/tweet')
	xUrl.searchParams.set('text', `I completed the ${courseName}.`)
	xUrl.searchParams.set('url', permalink)
	const linkedInUrl = new URL(
		'https://www.linkedin.com/sharing/share-offsite/',
	)
	linkedInUrl.searchParams.set('url', permalink)

	async function copyPermalink() {
		await navigator.clipboard.writeText(permalink)
		setCopied(true)
		window.setTimeout(() => setCopied(false), 2000)
	}

	const actionClassName =
		'focus-visible:ring-ring focus-visible:ring-offset-background inline-flex min-h-11 items-center justify-center gap-2 border border-border bg-background px-4 py-2 font-mono text-xs font-medium uppercase tracking-wider text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

	return (
		<div
			className="flex flex-wrap gap-2"
			data-certificate-share-url={permalink}
		>
			<a
				className={actionClassName}
				href={xUrl.toString()}
				target="_blank"
				rel="noreferrer"
			>
				<span aria-hidden="true" className="text-base leading-none">
					𝕏
				</span>
				Share on X
			</a>
			<a
				className={actionClassName}
				href={linkedInUrl.toString()}
				target="_blank"
				rel="noreferrer"
			>
				<Linkedin aria-hidden="true" className="size-4" />
				LinkedIn
			</a>
			<button
				className={actionClassName}
				type="button"
				onClick={copyPermalink}
			>
				{copied ? (
					<Check aria-hidden="true" className="size-4" />
				) : (
					<Copy aria-hidden="true" className="size-4" />
				)}
				{copied ? 'Copied' : 'Copy link'}
			</button>
		</div>
	)
}
