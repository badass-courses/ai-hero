'use client'

import React from 'react'
import { Check, Copy, GitBranch, RotateCcw } from 'lucide-react'
import Markdown from 'react-markdown'

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@coursebuilder/ui'

export function CommitMap({ children }: { children: React.ReactNode }) {
	return (
		<div className="my-6">
			<span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-xs uppercase">
				<svg
					className="dark:text-primary size-4 text-blue-600"
					xmlns="http://www.w3.org/2000/svg"
					width="24"
					height="24"
					fill="none"
					viewBox="0 0 24 24"
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
			<div className="not-prose bg-card relative rounded-xl border p-5">
				<div className="relative pl-6">
					<div className="dark:bg-foreground/10 bg-border absolute bottom-[-20px] left-[5px] top-[6px] w-px" />
					<div className="space-y-6">{children}</div>
				</div>
			</div>
		</div>
	)
}

export function Commit({
	id,
	children,
}: {
	id: string
	children: React.ReactNode
}) {
	const [copiedCommand, setCopiedCommand] = React.useState<string | null>(null)
	const [open, setOpen] = React.useState(false)
	const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

	React.useEffect(() => {
		return () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
		}
	}, [])

	const resetCommand = `pnpm reset ${id}`
	const cherryPickCommand = `pnpm cherry-pick ${id}`

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
		<div className="relative">
			<div className="dark:border-foreground/20 border-foreground/15 bg-background -left-7.5 absolute top-0.5 z-10 h-6 w-6 rounded-full border dark:border-2" />
			<div className="flex w-full flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex flex-col pl-2">
					<div className="flex items-center justify-between gap-2">
						<div className="font-mono font-bold sm:text-lg">{id}</div>
					</div>
					<div className="text-muted-foreground prose-sm prose prose-p:m-0 prose-a:text-primary text-sm">
						{typeof children === 'string' ? (
							<Markdown>{children}</Markdown>
						) : (
							children
						)}
					</div>
				</div>
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
							variant="outline"
							size="sm"
							className="h-7 gap-1.5 rounded-lg px-2.5 font-mono text-xs hover:cursor-pointer"
						>
							<Copy className="h-3.5 w-3.5" />
							Copy
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-72 rounded-xl">
						<DropdownMenuItem
							onSelect={(e) => {
								e.preventDefault()
								handleCopy(resetCommand)
							}}
							className="flex cursor-pointer flex-col items-start gap-1 rounded-lg p-3"
						>
							<div className="flex w-full items-center gap-2">
								{copiedCommand === resetCommand ? (
									<Check className="h-4 w-4 text-green-500" />
								) : (
									<RotateCcw className="h-4 w-4" />
								)}
								<span className="font-mono text-sm">{resetCommand}</span>
							</div>
							<span className="text-muted-foreground pl-6 text-xs">
								Resets your project to match this commit (loses previous work,
								no merge conflicts)
							</span>
						</DropdownMenuItem>
						{id === 'main' ? (
							<DropdownMenuItem
								disabled
								className="flex cursor-not-allowed flex-col items-start gap-1 rounded-lg p-3 opacity-50"
							>
								<div className="flex w-full items-center gap-2">
									<GitBranch className="h-4 w-4" />
									<span className="font-mono text-sm">{cherryPickCommand}</span>
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
								className="flex cursor-pointer flex-col items-start gap-1 rounded-lg p-3"
							>
								<div className="flex w-full items-center gap-2">
									{copiedCommand === cherryPickCommand ? (
										<Check className="h-4 w-4 text-green-500" />
									) : (
										<GitBranch className="h-4 w-4" />
									)}
									<span className="font-mono text-sm">{cherryPickCommand}</span>
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
		</div>
	)
}
