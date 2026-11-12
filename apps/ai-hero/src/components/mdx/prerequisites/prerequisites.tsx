import { Children, isValidElement, type ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { Heading } from '@/components/mdx/heading'
import { toInternalHref } from '@/utils/rehype-internal-links'
import { log } from '@/server/logger'

import { PrerequisitesBlock } from './prerequisites-block'
import { getPrerequisiteLessons } from './prerequisites-query'
import { PREREQUISITES_COOKIE, readRemembered } from './prerequisites-state'

/**
 * MDX side of the block the `remarkPrerequisites` plugin emits. The compiled
 * element tree is shared across users (`compiledMdxCache`), so everything here
 * is per-request: the lessons resolve on the server at render, the learner's
 * progress on the client. The remembered collapse state comes from a cookie,
 * read here at render (never at compile) and only where the caller allows a
 * request read: `readStateCookie` is set by the force-dynamic lesson route;
 * pages that compile MDX statically (posts are force-static) never call
 * `cookies()` from inside their body.
 */

type PrerequisiteProps = {
	module: string
	lesson: string
	/** The authored link and its text, for the fallback. */
	href: string
	label: string
	/** The authored reason, inline code kept. */
	children?: ReactNode
}

/** A data carrier: `Prerequisites` reads its props and renders the rows. */
export function Prerequisite(_props: PrerequisiteProps) {
	return null
}

function prerequisiteEntries(children: ReactNode): PrerequisiteProps[] {
	return Children.toArray(children).flatMap((child) =>
		isValidElement<PrerequisiteProps>(child) &&
		typeof child.props.module === 'string' &&
		typeof child.props.lesson === 'string'
			? [child.props]
			: [],
	)
}

function headingLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
	const value = Number(level)
	return value >= 1 && value <= 6 ? (value as 1 | 2 | 3 | 4 | 5 | 6) : 2
}

/** The heading and list as authored, for when a linked lesson is missing. */
function AuthoredList({
	title,
	level,
	entries,
}: {
	title: string
	level: 1 | 2 | 3 | 4 | 5 | 6
	entries: PrerequisiteProps[]
}) {
	return (
		<>
			<Heading level={level}>{title}</Heading>
			<ul className="ah-bullets">
				{entries.map((entry) => (
					<li key={`${entry.module}/${entry.lesson}`}>
						{/* The authored URL, made root-relative like any body link, so
						    a #fragment or query survives. */}
						<Link
							href={toInternalHref(entry.href) ?? entry.href}
							className="ah-prose-a"
						>
							{entry.label}
						</Link>
						: {entry.children}
					</li>
				))}
			</ul>
		</>
	)
}

export async function Prerequisites({
	title,
	level,
	hostLessonId,
	readStateCookie,
	children,
}: {
	title: string
	level?: string
	hostLessonId?: string
	readStateCookie?: boolean
	children?: ReactNode
}) {
	const entries = prerequisiteEntries(children)
	const depth = headingLevel(level)

	let lessons: Awaited<ReturnType<typeof getPrerequisiteLessons>> = null
	try {
		lessons = entries.length > 0 ? await getPrerequisiteLessons(entries) : null
	} catch (error) {
		void log.error('mdx.prerequisites.resolve.error', {
			hostLessonId,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	if (!lessons) {
		void log.warn('mdx.prerequisites.unresolved', {
			hostLessonId,
			lessons: entries.map((entry) => entry.lesson),
		})
		return <AuthoredList title={title} level={depth} entries={entries} />
	}

	const initialRemembered =
		readStateCookie && hostLessonId
			? readRemembered(
					(await cookies()).get(PREREQUISITES_COOKIE)?.value,
					hostLessonId,
				)
			: undefined

	return (
		<PrerequisitesBlock
			title={title}
			level={depth}
			hostLessonId={hostLessonId}
			initialRemembered={initialRemembered}
			items={lessons.map((lesson, index) => ({
				...lesson,
				reason: entries[index]?.children ?? null,
			}))}
		/>
	)
}
