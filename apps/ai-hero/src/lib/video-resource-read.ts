import 'server-only'

import { courseBuilderAdapter } from '@/db'

export async function getVideoResource(id: string | null | undefined) {
	return courseBuilderAdapter.getVideoResource(id)
}
