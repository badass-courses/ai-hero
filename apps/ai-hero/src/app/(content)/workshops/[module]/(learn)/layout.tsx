import React from 'react'
import { LessonPlayerHost } from '@/app/(content)/_components/lesson-player-host'
import { WorkshopResourceList } from '@/app/(content)/workshops/_components/workshop-resource-list'
import LayoutClient from '@/components/layout-client'
import { getServerAuthSession } from '@/server/auth'
import type { Session } from 'next-auth'

import { LessonRouteSessionProvider } from './lesson-route-session-provider'
import { LessonsSheet } from './lessons-sheet'

// Above [lesson], so it is not keyed by the lesson slug. It stays mounted
// across lesson, /solution and /exercise navigations, and so does the player
// it hosts. It must never read lesson data: everything per lesson stays in
// the page, behind its access check, and the page hands the player its video.
const LessonLayout = async (props: { children: React.ReactNode }) => {
	const { session } = await getServerAuthSession()

	const { children } = props

	return (
		<LessonRouteSessionProvider session={session as Session | null}>
			<LayoutClient withContainer>
				<div className="flex min-w-0">
					<WorkshopResourceList className="hidden lg:block" />
					<LessonsSheet />
					<div className="min-w-0 flex-1">
						<LessonPlayerHost>{children}</LessonPlayerHost>
					</div>
				</div>
			</LayoutClient>
		</LessonRouteSessionProvider>
	)
}

export default LessonLayout
