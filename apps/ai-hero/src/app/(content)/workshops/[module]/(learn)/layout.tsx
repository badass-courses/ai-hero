import React from 'react'
import { LessonPlayerHost } from '@/app/(content)/_components/lesson-player-host'
import { SESSION_PANEL_BOOT_SCRIPT } from '@/app/(content)/_components/session-panel-boot'
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
			{/* Synchronous and before the lesson: a viewer who hid the session
			    panel never sees it flash at hydration. The player host keeps the
			    attribute in step after that. */}
			<script
				id="session-panel-bootstrap"
				dangerouslySetInnerHTML={{ __html: SESSION_PANEL_BOOT_SCRIPT }}
			/>
			{/* Uncapped: the player caps itself at 75svh tall, so it grows with
			    the screen, and the lesson text keeps its own reading width. */}
			<LayoutClient withContainer className="max-w-none">
				<div className="flex min-w-0">
					<WorkshopResourceList className="hidden lg:block" />
					<LessonsSheet />
					{/* Relative: the lesson page pins its scroll target to this top. */}
					<div className="relative min-w-0 flex-1">
						<LessonPlayerHost>{children}</LessonPlayerHost>
					</div>
				</div>
			</LayoutClient>
		</LessonRouteSessionProvider>
	)
}

export default LessonLayout
