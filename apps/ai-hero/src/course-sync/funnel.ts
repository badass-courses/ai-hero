export type CourseSyncFunnelEntry = {
	timestamp: Date
	stage: string
	outcome: string
	pollRunId?: string | null
	controlPlaneRunId?: string | null
	failureClass?: string | null
	metadata?: Record<string, unknown> | null
}

export function formatCourseSyncFunnel(
	courseVersionId: string,
	entries: ReadonlyArray<CourseSyncFunnelEntry>,
) {
	const lines = [`courseVersionId=${courseVersionId}`]
	for (const entry of [...entries].sort(
		(left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
	)) {
		const fields = [
			entry.timestamp.toISOString(),
			entry.stage,
			entry.outcome,
			entry.pollRunId ? `poll=${entry.pollRunId}` : null,
			entry.controlPlaneRunId ? `sync=${entry.controlPlaneRunId}` : null,
			entry.failureClass ? `failure=${entry.failureClass}` : null,
			entry.metadata && Object.keys(entry.metadata).length > 0
				? `metadata=${JSON.stringify(entry.metadata)}`
				: null,
		].filter(Boolean)
		lines.push(fields.join(' '))
	}
	return lines.join('\n')
}
