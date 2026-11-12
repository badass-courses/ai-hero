import { Children, isValidElement, type ReactNode } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { Heading } from '@/components/mdx/heading'
import {
	DEFAULT_PREREQUISITES_TITLE,
	parseLessonUrl,
} from '@/lib/prerequisites-normalize'
import { toInternalHref } from '@/utils/rehype-internal-links'
import { log } from '@/server/logger'

import { PrerequisitesBlock } from './prerequisites-block'
import { getPrerequisiteLessons } from './prerequisites-query'
import { PREREQUISITES_COOKIE, readRemembered } from './prerequisites-state'

/**
 * The authored block:
 *
 *   <Prerequisites title="Crash Course Prerequisites">
 *     <Prerequisite href="https://www.aihero.dev/workshops/<module>/<lesson>">
 *       Why it matters.
 *     </Prerequisite>
 *   </Prerequisites>
 *
 * The compiled element tree is shared across users (`compiledMdxCache`), so
 * everything here is per-request: the lessons resolve on the server at
 * render, the learner's progress on the client. The remembered collapse state
 * comes from a cookie, read here at render (never at compile) and only where
 * the caller allows a request read: `readStateCookie` is set by the
 * force-dynamic lesson route; pages that compile MDX statically (posts are
 * force-static) never call `cookies()` from inside their body.
 */

type PrerequisiteProps = {
	/** The lesson URL: absolute aihero.dev or `/workshops/<module>/<lesson>`. */
	href: string
	/** Why the lesson matters here. Inline code is kept. */
	children?: ReactNode
}

/** A data carrier: `Prerequisites` reads its props and renders the rows. */
export function Prerequisite(_props: PrerequisiteProps) {
	return null
}

function prerequisiteEntries(children: ReactNode): PrerequisiteProps[] {
	return Children.toArray(children).flatMap((child) =>
		isValidElement<PrerequisiteProps>(child) &&
		typeof child.props.href === 'string'
			? [child.props]
			: [],
	)
}

/**
 * Shown when a link is not a lesson URL or its lesson is missing, so the
 * author sees which links are off and a learner still gets working links.
 */
function AuthoredList({
	title,
	entries,
}: {
	title: string
	entries: PrerequisiteProps[]
}) {
	return (
		<>
			<Heading level={2}>{title}</Heading>
			<ul className="ah-bullets">
				{entries.map((entry) => (
					<li key={entry.href}>
						<Link
							href={toInternalHref(entry.href) ?? entry.href}
							className="ah-prose-a"
						>
							{entry.href}
						</Link>
						: {entry.children}
					</li>
				))}
			</ul>
		</>
	)
}

export async function Prerequisites({
	title = DEFAULT_PREREQUISITES_TITLE,
	hostLessonId,
	readStateCookie,
	children,
}: {
	title?: string
	hostLessonId?: string
	readStateCookie?: boolean
	children?: ReactNode
}) {
	const entries = prerequisiteEntries(children)
	if (entries.length === 0) {
		void log.warn('mdx.prerequisites.empty', { hostLessonId })
		return null
	}

	const links = entries.flatMap((entry) => parseLessonUrl(entry.href) ?? [])

	let lessons: Awaited<ReturnType<typeof getPrerequisiteLessons>> = null
	try {
		lessons =
			links.length === entries.length
				? await getPrerequisiteLessons(links)
				: null
	} catch (error) {
		void log.error('mdx.prerequisites.resolve.error', {
			hostLessonId,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	if (!lessons) {
		void log.warn('mdx.prerequisites.unresolved', {
			hostLessonId,
			links: entries.map((entry) => entry.href),
		})
		return <AuthoredList title={title} entries={entries} />
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
			hostLessonId={hostLessonId}
			initialRemembered={initialRemembered}
			items={lessons.map((lesson, index) => ({
				...lesson,
				reason: entries[index]?.children ?? null,
			}))}
		/>
	)
}
