'use client'

import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { LESSON_DENIAL_COPY, parseDeniedReason } from '@/lib/lesson-denial'
import { Lock } from 'lucide-react'

function Notice() {
	const reason = parseDeniedReason(useSearchParams().get('denied'))
	if (!reason) return null
	return (
		<p
			role="status"
			data-lesson-denied={reason}
			className="border-border bg-muted/40 mb-6 flex items-start gap-2 border p-4 text-sm"
		>
			<Lock className="mt-0.5 size-4 shrink-0 opacity-75" />
			<span>{LESSON_DENIAL_COPY[reason]}</span>
		</p>
	)
}

/**
 * Why the lesson sent the reader here. Read on the client because the module
 * page is static: the reason arrives as `?denied=<reason>` from a whitelist.
 */
export function LessonDeniedNotice() {
	return (
		<Suspense fallback={null}>
			<Notice />
		</Suspense>
	)
}
