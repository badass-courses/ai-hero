import type {
	WorkshopAccessBranch,
	WorkshopAccessTree,
} from '@/lib/workshop-access-tree'

export async function getResourceSection(
	resourceId: string,
	moduleResource?: WorkshopAccessTree | null,
): Promise<WorkshopAccessBranch | null> {
	if (!moduleResource?.resources) return null
	let sectionData: WorkshopAccessBranch | null = null

	moduleResource.resources.forEach((section) => {
		const resource = section?.resource
		if (resource?.type !== 'section') return

		if (section.resourceId === resourceId) {
			sectionData = resource
		}

		resource.resources.forEach((lesson) => {
			if (lesson.resourceId === resourceId) {
				sectionData = resource
			}
		})
	})

	return sectionData
}
