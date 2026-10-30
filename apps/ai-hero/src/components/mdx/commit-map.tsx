'use client'

import React from 'react'
import { TYPE } from '@/components/landing/type'
import { Markdown } from '@/components/markdown'
import { Check, ChevronDown, Copy, GitBranch, RotateCcw } from 'lucide-react'

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

type PackageManager = 'npm' | 'pnpm'

// Older courses were published against the pnpm default; newer npm-based
// courses opt in via <CommitMap packageManager="npm">.
const PackageManagerContext = React.createContext<PackageManager>('pnpm')

export function CommitMap({
	children,
	packageManager = 'pnpm',
}: {
	children: React.ReactNode
	packageManager?: PackageManager
}) {
	return (
		<PackageManagerContext.Provider value={packageManager}>
			<div className="my-6">
				<span
					className={cn(
						TYPE.groupLabel,
						'mb-2 inline-flex items-center gap-1.5',
					)}
				>
					<svg
						className="size-3.5"
						xmlns="http://www.w3.org/2000/svg"
						width="24"
						height="24"
						fill="none"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<path
							stroke="currentColor"
							strokeWidth="1.5"
							d="M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm10 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
						/>
						<path
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth="1.5"
							d="M7.021 8.28v7.127m7.39-3.402H10.02c-1.097 0-3.157-.88-3-3.225"
						/>
					</svg>
					Commits
				</span>
				{/* A git log: a small node per commit at its id's line, joined to
				    the next by a hairline. */}
				<ol className="not-prose bg-card relative rounded-[12px] border px-5 py-4 sm:px-6">
					{children}
				</ol>
			</div>
		</PackageManagerContext.Provider>
	)
}

export function Commit({
	id,
	children,
}: {
	id: string
	children: React.ReactNode
}) {
	const packageManager = React.useContext(PackageManagerContext)
	const [copiedCommand, setCopiedCommand] = React.useState<string | null>(null)
	const [open, setOpen] = React.useState(false)
	const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

	React.useEffect(() => {
		return () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
		}
	}, [])

	const runPrefix = packageManager === 'npm' ? 'npm run' : 'pnpm'
	const resetCommand = `${runPrefix} reset ${id}`
	const cherryPickCommand = `${runPrefix} cherry-pick ${id}`

	const handleCopy = async (command: string) => {
		await navigator.clipboard.writeText(command)
		setCopiedCommand(command)
		if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
		closeTimerRef.current = setTimeout(() => {
			setOpen(false)
			setCopiedCommand(null)
		}, 1000)
	}

	return (
		<li className="after:bg-border relative py-2.5 pl-6 after:absolute after:top-5 after:-bottom-5 after:left-[4px] after:w-px last:after:hidden">
			<span
				aria-hidden="true"
				className="border-foreground/45 bg-card absolute top-4 left-0 z-10 size-[9px] rounded-full border-[1.5px]"
			/>
			{/* The copy sits right after the id it acts on, where the eye
			    already is, rather than across the row. */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className={cn(TYPE.cardTitle, 'font-mono font-semibold')}>
					{id}
				</span>
				<DropdownMenu
					modal={false}
					open={open}
					onOpenChange={(next) => {
						setOpen(next)
						if (!next) setCopiedCommand(null)
					}}
				>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							aria-label={`Copy a command for ${id}`}
							className={cn(
								TYPE.metaSm,
								'text-muted-foreground hover:text-foreground data-[state=open]:text-foreground -my-1 h-7 gap-1 rounded-[6px] px-2 hover:cursor-pointer',
							)}
						>
							<Copy className="size-3.5" aria-hidden="true" />
							Copy command
							<ChevronDown className="size-3" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-72 rounded-[11px]">
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault()
								handleCopy(resetCommand)
							}}
							className="flex cursor-pointer flex-col items-start gap-1 rounded-[6px] p-3"
						>
							<div className="flex w-full items-center gap-2">
								{copiedCommand === resetCommand ? (
									<Check className="text-primary size-4" />
								) : (
									<RotateCcw className="size-4" />
								)}
								<span className={TYPE.metaMono}>{resetCommand}</span>
							</div>
							<span className="text-muted-foreground pl-6 text-xs">
								Resets your project to match this commit (loses previous work,
								no merge conflicts)
							</span>
						</DropdownMenuItem>
						{id === 'main' ? (
							<DropdownMenuItem
								disabled
								className="flex cursor-not-allowed flex-col items-start gap-1 rounded-[6px] p-3 opacity-50"
							>
								<div className="flex w-full items-center gap-2">
									<GitBranch className="size-4" />
									<span className={TYPE.metaMono}>{cherryPickCommand}</span>
								</div>
								<span className="text-muted-foreground pl-6 text-xs">
									cherry-pick won't work on main, since there are no changes to
									apply. If you want to start the course again, use reset
									instead.
								</span>
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem
								onSelect={(e) => {
									e.preventDefault()
									handleCopy(cherryPickCommand)
								}}
								className="flex cursor-pointer flex-col items-start gap-1 rounded-[6px] p-3"
							>
								<div className="flex w-full items-center gap-2">
									{copiedCommand === cherryPickCommand ? (
										<Check className="text-primary size-4" />
									) : (
										<GitBranch className="size-4" />
									)}
									<span className={TYPE.metaMono}>{cherryPickCommand}</span>
								</div>
								<span className="text-muted-foreground pl-6 text-xs">
									Applies changes from this commit to your project (keeps
									previous work, might cause merge conflicts)
								</span>
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div
				className={cn(
					TYPE.meta,
					'text-muted-foreground prose prose-sm prose-p:m-0 prose-a:text-primary mt-1 max-w-none leading-relaxed font-normal',
				)}
			>
				{typeof children === 'string' ? (
					<Markdown>{children}</Markdown>
				) : (
					children
				)}
			</div>
		</li>
	)
}
