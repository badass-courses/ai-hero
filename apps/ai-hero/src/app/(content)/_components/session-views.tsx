'use client'

import * as React from 'react'
import {
	Message,
	MessageContent,
	MessageResponse,
} from '@/components/ai-elements/message'
import { TYPE } from '@/components/landing/type'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import type { SessionExtract } from '@/lib/session-extract'
import {
	extractMoments,
	type CorrectionMoment,
	type ErrorMoment,
	type Moment,
	type MomentKind,
	type PromptMoment,
	type SkillMoment,
} from '@ai-hero/learner-agent/views'
import {
	ArrowUpRight,
	CheckIcon,
	ClipboardIcon,
	SparklesIcon,
	XCircleIcon,
} from 'lucide-react'

import { TabsList, TabsTrigger } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { formatTime, seekPlayer, usePlayerTime } from './session-player-time'

/**
 * The session's moments as lists beside the live view: every prompt Matt
 * typed, each skill he ran, each time he cut the agent off, and each failed
 * tool call, all derived from the extract's entries (the same derivation the
 * learner agent's `session_extract` views use). Every moment's time seeks
 * the video.
 */

export type SessionTab =
	| 'live'
	| 'prompts'
	| 'skills'
	| 'corrections'
	| 'errors'

const TAB_KIND = {
	prompts: 'prompt',
	skills: 'skill',
	corrections: 'correction',
	errors: 'error',
} as const satisfies Record<Exclude<SessionTab, 'live'>, MomentKind>

const TAB_LABEL: Record<SessionTab, string> = {
	live: 'Live',
	prompts: 'Prompts',
	skills: 'Skills',
	corrections: 'Corrections',
	errors: 'Errors',
}

const ALL_KINDS = Object.values(TAB_KIND)

/**
 * The tabs this extract fills, live first; a view with nothing in it gets no
 * tab. `skillLinks` maps a `skillKey` to its page.
 */
export function useSessionViews(
	extract: SessionExtract,
	skillLinks: Readonly<Record<string, string>> | undefined,
) {
	return React.useMemo(() => {
		const moments = extractMoments(
			extract,
			ALL_KINDS,
			new Map(Object.entries(skillLinks ?? {})),
		)
		const byTab = Object.fromEntries(
			Object.entries(TAB_KIND).map(([tab, kind]) => [
				tab,
				moments.filter((moment) => moment.kind === kind),
			]),
		) as Record<Exclude<SessionTab, 'live'>, Moment[]>
		const tabs: SessionTab[] = [
			'live',
			...(Object.keys(TAB_KIND) as Array<keyof typeof TAB_KIND>).filter(
				(tab) => byTab[tab].length > 0,
			),
		]
		return { tabs, byTab }
	}, [extract, skillLinks])
}

/** The strip of view names under the panel header. */
export function SessionViewTabs({ tabs }: { tabs: SessionTab[] }) {
	return (
		<div className="border-b px-3 py-2">
			<TabsList
				aria-label="Session views"
				className="h-7 w-full justify-start gap-0.5 overflow-x-auto rounded-[8px] p-[2px]"
			>
				{tabs.map((tab) => (
					<TabsTrigger
						key={tab}
						value={tab}
						className={cn(
							TYPE.metaSm,
							'flex-none rounded-[6px] px-2 font-medium',
						)}
					>
						{TAB_LABEL[tab]}
					</TabsTrigger>
				))}
			</TabsList>
		</div>
	)
}

/**
 * One view's moments, in video order. The moment the video has most recently
 * passed is marked, so the list reads as a map of where the lesson is.
 */
export function SessionMomentList({ moments }: { moments: Moment[] }) {
	const { muxPlayerRef } = useMuxPlayer()
	const time = usePlayerTime(muxPlayerRef)
	const seek = (seconds: number) => seekPlayer(muxPlayerRef, seconds)
	const current = moments.findLastIndex((moment) => moment.visibleFrom <= time)

	return (
		<ol className="divide-border/60 min-h-0 flex-1 divide-y overflow-y-auto px-3 pb-4">
			{moments.map((moment, index) => (
				<li
					key={`${moment.sessionId}-${moment.visibleFrom}-${index}`}
					aria-current={index === current ? 'true' : undefined}
					className={cn(
						'border-l-2 border-transparent py-3 pl-2.5',
						index === current && 'border-l-primary',
					)}
				>
					<MomentBody moment={moment} seek={seek} />
				</li>
			))}
		</ol>
	)
}

function MomentBody({
	moment,
	seek,
}: {
	moment: Moment
	seek: (seconds: number) => void
}) {
	switch (moment.kind) {
		case 'prompt':
			return <PromptRow moment={moment} seek={seek} />
		case 'correction':
			return <CorrectionRow moment={moment} seek={seek} />
		case 'skill':
			return <SkillRow moment={moment} seek={seek} />
		case 'error':
			return <ErrorRow moment={moment} seek={seek} />
	}
}

function TimeButton({
	seconds,
	seek,
}: {
	seconds: number
	seek: (seconds: number) => void
}) {
	return (
		<button
			type="button"
			onClick={() => seek(seconds)}
			aria-label={`Play from ${formatTime(seconds)}`}
			className={cn(
				TYPE.navNum,
				'text-muted-foreground hover:text-foreground h-3.5 rounded-[3px] px-0.5',
			)}
		>
			{formatTime(seconds)}
		</button>
	)
}

function PromptBubble({ text }: { text: string }) {
	return (
		<Message from="user" className="max-w-[92%]">
			<MessageContent
				className={cn(
					TYPE.metaProse,
					'whitespace-pre-wrap break-words group-[.is-user]:px-3 group-[.is-user]:py-2',
				)}
			>
				{text}
			</MessageContent>
		</Message>
	)
}

function PromptRow({
	moment,
	seek,
}: {
	moment: PromptMoment
	seek: (seconds: number) => void
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between">
				<TimeButton seconds={moment.visibleFrom} seek={seek} />
				<CopyPromptButton text={moment.text} />
			</div>
			<PromptBubble text={moment.text} />
		</div>
	)
}

function CopyPromptButton({ text }: { text: string }) {
	const [copied, setCopied] = React.useState(false)
	React.useEffect(() => {
		if (!copied) return
		const timer = setTimeout(() => setCopied(false), 2000)
		return () => clearTimeout(timer)
	}, [copied])
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}
	return (
		<button
			type="button"
			onClick={() => void copy()}
			aria-label={copied ? 'Prompt copied' : 'Copy prompt'}
			className={cn(
				TYPE.metaSm,
				'text-muted-foreground hover:text-foreground flex items-center gap-1 rounded-[4px] px-1 py-0.5',
			)}
		>
			{copied ? (
				<CheckIcon className="size-3.5" aria-hidden />
			) : (
				<ClipboardIcon className="size-3.5" aria-hidden />
			)}
			{copied ? 'Copied' : 'Copy'}
		</button>
	)
}

function FollowedBy({
	label,
	seconds,
	seek,
	children,
}: {
	label: string
	seconds: number
	seek: (seconds: number) => void
	children: React.ReactNode
}) {
	return (
		<div className="mt-2 flex flex-col gap-1.5">
			<div className="flex items-center gap-2">
				<span className={cn(TYPE.metaSm, 'text-muted-foreground')}>
					{label}
				</span>
				<TimeButton seconds={seconds} seek={seek} />
			</div>
			{children}
		</div>
	)
}

function CorrectionRow({
	moment,
	seek,
}: {
	moment: CorrectionMoment
	seek: (seconds: number) => void
}) {
	return (
		<div>
			<TimeButton seconds={moment.visibleFrom} seek={seek} />
			<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-1 italic')}>
				{/* The interrupt as the session shows it; some carry no text. */}
				{moment.interrupt.trim() || 'Interrupted'}
			</p>
			{moment.followedBy && (
				<FollowedBy
					label="Next prompt"
					seconds={moment.followedBy.visibleFrom}
					seek={seek}
				>
					<PromptBubble text={moment.followedBy.text} />
				</FollowedBy>
			)}
		</div>
	)
}

function SkillRow({
	moment,
	seek,
}: {
	moment: SkillMoment
	seek: (seconds: number) => void
}) {
	return (
		<div>
			<TimeButton seconds={moment.visibleFrom} seek={seek} />
			<div
				className={cn(
					TYPE.metaSm,
					'text-muted-foreground mt-1 flex items-center gap-1.5',
				)}
			>
				<SparklesIcon className="size-3 shrink-0" aria-hidden />
				<span className="min-w-0 break-words">
					Skill <span className="text-primary">{moment.skill}</span>
					{moment.args && <> {moment.args}</>}
				</span>
				{moment.skillUrl && (
					<a
						href={moment.skillUrl}
						target="_blank"
						rel="noreferrer"
						className="hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-0.5"
					>
						Skill page
						<ArrowUpRight className="size-3" aria-hidden />
					</a>
				)}
			</div>
		</div>
	)
}

function ErrorRow({
	moment,
	seek,
}: {
	moment: ErrorMoment
	seek: (seconds: number) => void
}) {
	const recovery = moment.recovery
	return (
		<div>
			<TimeButton seconds={moment.visibleFrom} seek={seek} />
			<div
				className={cn(
					TYPE.metaSm,
					'text-muted-foreground mt-1 flex items-center gap-1.5',
				)}
			>
				<XCircleIcon
					className="text-destructive size-3 shrink-0"
					aria-label="Failed"
				/>
				<span className="min-w-0 break-words">
					<span className="text-foreground/80">{moment.tool}</span>
					{moment.summary && <> · {moment.summary}</>}
				</span>
			</div>
			{recovery && (
				<FollowedBy
					label={recovery.kind === 'userPrompt' ? 'Next prompt' : 'Next reply'}
					seconds={recovery.visibleFrom}
					seek={seek}
				>
					{recovery.kind === 'userPrompt' ? (
						<PromptBubble text={recovery.text} />
					) : (
						// A reply can run long; the list shows its start, and its
						// time plays the rest.
						<div className="max-h-24 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]">
							<MessageResponse className={cn(TYPE.metaProse, 'text-sm')}>
								{recovery.text}
							</MessageResponse>
						</div>
					)}
				</FollowedBy>
			)}
		</div>
	)
}
