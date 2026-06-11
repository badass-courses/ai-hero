'use client'

import { useRef } from 'react'
import { MailPlus } from 'lucide-react'

import CopyToClipboard from './copy-to-clipboard'

export default function BossLetterArticle({
	children,
}: {
	children: React.ReactNode
}) {
	const articleRef = useRef<HTMLElement>(null)

	return (
		<article
			ref={articleRef}
			className="lg:prose-lg prose dark:prose-invert bg-card relative mx-auto w-full max-w-3xl overflow-hidden rounded-lg p-5 shadow ring ring-gray-300/10 sm:p-8"
		>
			<CopyToClipboard articleRef={articleRef} />
			<MailPlus
				className="text-foreground absolute -left-16 -top-16 size-80 rotate-6 opacity-5"
				aria-hidden
			/>
			{children}
		</article>
	)
}
