'use client'

import * as React from 'react'
import { SessionProvider } from 'next-auth/react'
import type { Session } from 'next-auth'

export function LessonRouteSessionProvider({
	children,
	session,
}: {
	children: React.ReactNode
	session: Session | null
}) {
	return <SessionProvider session={session}>{children}</SessionProvider>
}
