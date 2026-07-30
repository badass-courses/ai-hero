import {
	loadCourseSyncFunnelEntries,
	resolveCourseSyncFunnelVersion,
} from '@/course-sync/funnel-query'
import { formatCourseSyncFunnel } from '@/course-sync/funnel'

async function main() {
	const courseVersionId = await resolveCourseSyncFunnelVersion(process.argv[2])
	const entries = await loadCourseSyncFunnelEntries(courseVersionId)
	console.log(formatCourseSyncFunnel(courseVersionId, entries))
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
