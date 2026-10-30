import { TYPE } from '@/components/landing/type'
import { Bot, Laptop, User } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { LINE_INK } from './hues'
import { ServerSlab } from './icons'

/**
 * Matt's sandboxing argument in icons: every bot on one laptop, against one
 * bot per remote server. He grows it over the video, so a frame says how many
 * columns of servers he had drawn and whether the people were in yet.
 */
export type BotSandboxesFrame = {
	/** Columns of server-and-bot pairs, three rows each. */
	columns: 1 | 3
	/** One person drives the laptop; a team fans out to the servers. */
	people?: boolean
}

const ICON = 'size-5 shrink-0 @2xl:size-8'

/** "=" set the way Matt writes it between the icons. */
function Equals() {
	return (
		<span aria-hidden className={cn(TYPE.panelTitle, 'px-1 @2xl:px-2')}>
			=
		</span>
	)
}

/** Matt's laptop-versus-servers sketch, drawn from a `BotSandboxesFrame`. */
export function BotSandboxes({ frame }: { frame: BotSandboxesFrame }) {
	const rows = [0, 1, 2]
	const columns = Array.from({ length: frame.columns }, (_, i) => i)
	return (
		<figure className="not-prose @container my-8">
			<div className="space-y-12 @2xl:space-y-16 @2xl:pl-[6%]">
				<div
					data-node="laptop"
					role="img"
					aria-label={
						frame.people
							? 'One person on one laptop, running eight bots'
							: 'One laptop running eight bots'
					}
					className="flex items-center gap-2 @2xl:gap-3"
				>
					{frame.people ? (
						<>
							<User aria-hidden className={ICON} />
							<Arrow edge="person-laptop" />
						</>
					) : null}
					<Laptop aria-hidden className={ICON} />
					<Equals />
					<span className="grid grid-cols-4 gap-1 @2xl:gap-2">
						{Array.from({ length: 8 }, (_, i) => (
							<Bot key={i} aria-hidden className={ICON} />
						))}
					</span>
				</div>
				<div className="flex items-center gap-2 @2xl:gap-3">
					{frame.people ? (
						<>
							<span
								data-node="team"
								role="img"
								aria-label="A team of six people"
								className="grid shrink-0 grid-cols-2 gap-x-1 gap-y-3 @2xl:gap-x-3 @2xl:gap-y-5"
							>
								{Array.from({ length: 6 }, (_, i) => (
									<User key={i} aria-hidden className={ICON} />
								))}
							</span>
							<FanOut />
						</>
					) : null}
					<ul
						aria-label="One bot per server"
						className="grid gap-x-5 gap-y-3 @2xl:gap-x-10 @2xl:gap-y-5"
						style={{ gridTemplateColumns: `repeat(${frame.columns}, auto)` }}
					>
						{rows.flatMap((row) =>
							columns.map((column) => (
								<li
									key={`${row}-${column}`}
									data-node={`server-${row + 1}-${column + 1}`}
									className="flex h-5 items-center @2xl:h-8"
								>
									<ServerSlab className={ICON} />
									<Equals />
									<Bot aria-label="Bot" className={ICON} />
								</li>
							)),
						)}
					</ul>
				</div>
			</div>
		</figure>
	)
}

/** A short arrow from the person to the laptop. */
function Arrow({ edge }: { edge: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 40 12"
			className={cn(LINE_INK, 'h-3 w-7 shrink-0 @2xl:w-10')}
		>
			<path
				data-edge={edge}
				d="M2 6h35M32 1.5 37.5 6 32 10.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	)
}

/** Three arrows fanning from the team to the three rows of servers. The rows
    keep one pitch at each size (icon plus row gap), so the arrows are drawn
    to that pitch and scale with it. */
function FanOut() {
	return (
		<svg
			aria-hidden
			viewBox="0 0 48 84"
			className={cn(
				LINE_INK,
				'h-[84px] w-12 shrink-0 @2xl:h-[136px] @2xl:w-[78px]',
			)}
		>
			{[10, 42, 74].map((y, i) => (
				<path
					key={y}
					data-edge={`team-server-${i + 1}-1`}
					d={`M2 42 C 20 42 26 ${y} 44 ${y} M39.5 ${y - 4} 44.5 ${y} 39.5 ${y + 4}`}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.75"
					strokeLinecap="round"
					strokeLinejoin="round"
					vectorEffect="non-scaling-stroke"
				/>
			))}
		</svg>
	)
}
