import type { AnalyticsRange } from '@/lib/analytics'
import type { DashboardSection } from '@/lib/analytics/dashboard-contract'

export type SectionRequest = {
	section: DashboardSection
	range: AnalyticsRange
	generation: number
	bootstrap?: boolean
}

/** A local queue for dashboard requests; retries use the same two workers. */
export function createSectionRequestQueue(
	run: (request: SectionRequest) => Promise<void>,
	concurrency = 2,
) {
	const queue: SectionRequest[] = []
	const pending = new Set<string>()
	let active = 0

	const keyFor = (request: SectionRequest) =>
		`${request.generation}:${request.range}:${request.section}`
	const pump = () => {
		while (active < Math.max(1, concurrency) && queue.length > 0) {
			const request = queue.shift()!
			active += 1
			void run(request).finally(() => {
				active -= 1
				pending.delete(keyFor(request))
				pump()
			})
		}
	}

	return {
		enqueue(request: SectionRequest) {
			const key = keyFor(request)
			if (pending.has(key)) return false
			pending.add(key)
			queue.push(request)
			pump()
			return true
		},
		clear() {
			for (const request of queue) pending.delete(keyFor(request))
			queue.length = 0
		},
		get activeCount() {
			return active
		},
	}
}
