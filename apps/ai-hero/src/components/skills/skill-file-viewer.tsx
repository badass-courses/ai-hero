'use client'

import * as React from 'react'
import Link from 'next/link'
import { Markdown } from '@/components/markdown'
import { TYPE } from '@/components/landing/type'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import type { SkillFile } from '@/lib/skill-file'
import { ArrowUpRight, FileText, Github } from 'lucide-react'

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/utils/cn'

/**
 * `sm:max-w-4xl` deliberately overrides the shared dialog primitive's
 * `max-w-lg`. The flex/min-height pair makes the document, rather than the
 * whole modal, own vertical scrolling while the header and close button stay
 * put.
 */
export const SKILL_FILE_DIALOG_CLASS =
	'flex max-h-[90svh] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:w-[90vw] sm:max-w-4xl'
export const SKILL_FILE_SCROLL_CLASS =
	'min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 py-6 sm:px-7 sm:py-8'

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
			<DialogContent lockScroll={false} className={SKILL_FILE_DIALOG_CLASS}>
				<div className="border-border flex shrink-0 items-end justify-between gap-6 border-b px-5 py-4 pr-12 sm:py-5 sm:pl-7 sm:pr-16">
					<div>
						<DialogTitle className="text-xl">Full SKILL.md</DialogTitle>
						<DialogDescription className="mt-1">
							The agent-facing instructions, separate from the guide on this page.
						</DialogDescription>
					</div>
					<Button
						asChild
						variant="outline"
						size="sm"
						className="hidden flex-none rounded-[7px] sm:inline-flex"
					>
						<Link href={file.sourceUrl} target="_blank" rel="noreferrer">
							<Github aria-hidden className="text-muted-foreground size-4" />
							View on GitHub
						</Link>
					</Button>
				</div>
				<div
					role="region"
					aria-label="Full skill file"
					tabIndex={0}
					className={SKILL_FILE_SCROLL_CLASS}
				>
					<SkillFileContent file={file} />
				</div>
			</DialogContent>
		</Dialog>
	)
}

export function SkillFileContent({ file }: { file: SkillFile }) {
	return (
		<div
			className={cn(
				'mx-auto min-w-0 [&_pre]:max-w-full [&_pre]:overflow-x-auto',
				PROSE_MEASURE,
			)}
		>
			{file.metadata !== null ? (
				<section aria-label="Skill metadata" className="mb-8">
					<dl className="border-border divide-border divide-y rounded-[9px] border">
						{file.metadata.map(({ key, value }) => (
							<div
								key={key}
								className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-6"
							>
								<dt
									className={cn(TYPE.metaMono, 'text-muted-foreground break-words')}
								>
									{key}
								</dt>
								<dd
									className={cn(
										TYPE.meta,
										'text-foreground break-words font-normal',
									)}
								>
									{value}
								</dd>
							</div>
						))}
					</dl>
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
