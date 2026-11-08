'use client'

import * as React from 'react'
import Link from 'next/link'
import { Markdown } from '@/components/markdown'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import type { SkillFile } from '@/lib/skill-file'
import { ArrowUpRight, FileText } from 'lucide-react'

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

export function SkillFileViewer({
	file,
	className,
}: {
	file: SkillFile
	className?: string
}) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className={cn('rounded-[7px]', className)}
				>
					<FileText aria-hidden className="size-4" />
					Read full SKILL.md
				</Button>
			</DialogTrigger>
			<DialogContent
				lockScroll={false}
				className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-4xl gap-0 overflow-hidden rounded-xl p-0"
			>
				<div className="border-border flex items-start justify-between gap-6 border-b px-5 py-4 pr-12 sm:px-7 sm:py-5">
					<div>
						<DialogTitle className="text-xl">Full SKILL.md</DialogTitle>
						<DialogDescription className="mt-1">
							The agent-facing instructions, separate from the guide on this page.
						</DialogDescription>
					</div>
					<Link
						href={file.sourceUrl}
						target="_blank"
						rel="noreferrer"
						className="text-primary focus-visible:ring-ring hidden flex-none items-center gap-1.5 rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 sm:flex"
					>
						GitHub
						<ArrowUpRight aria-hidden className="size-4" />
					</Link>
				</div>
				<div className="overflow-y-auto px-5 py-6 sm:px-7 sm:py-8">
					<SkillFileContent file={file} />
				</div>
			</DialogContent>
		</Dialog>
	)
}

export function SkillFileContent({ file }: { file: SkillFile }) {
	return (
		<div className={cn('mx-auto', PROSE_MEASURE)}>
			{file.frontmatter !== null ? (
				<section aria-label="Skill metadata" className="mb-8">
					<p className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-[0.14em]">
						Metadata
					</p>
					<pre className="bg-muted border-border overflow-x-auto rounded-lg border p-4 text-xs leading-5">
						<code>{file.frontmatter}</code>
					</pre>
				</section>
			) : null}
			<div className="prose prose-sm prose-a:text-primary dark:prose-invert sm:prose-base max-w-none">
				<Markdown>{file.body}</Markdown>
			</div>
			<Link
				href={file.sourceUrl}
				target="_blank"
				rel="noreferrer"
				className="text-primary focus-visible:ring-ring mt-8 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 sm:hidden"
			>
				View on GitHub
				<ArrowUpRight aria-hidden className="size-4" />
			</Link>
		</div>
	)
}
