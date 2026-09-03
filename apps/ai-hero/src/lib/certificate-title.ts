/**
 * A cohort day's title carries its schedule ("Day 9: Advanced Patterns");
 * the certificate names the subject, not the day it was taught on.
 */
export function certificateTitleFor(title: string | null | undefined) {
	return (title ?? '').replace(/^day\s+\d+\s*[:.-]?\s*/i, '').trim()
}
