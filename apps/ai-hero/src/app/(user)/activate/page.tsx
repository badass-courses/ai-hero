import * as React from 'react'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { db } from '@/db'
import { deviceVerifications } from '@/db/schema'
import {
	deviceGrantFromCode,
	mintDeviceConsent,
} from '@/server/device-token-grant'
import { eq } from 'drizzle-orm'
import { getServerAuthSession } from '@/server/auth'

import Verify from './_components/verifiy'

export default async function Activate(props: {
	searchParams: Promise<{ user_code: string }>
}) {
	const searchParams = await props.searchParams
	const { session } = await getServerAuthSession()
	const userCode = searchParams.user_code
	const unAuthedCallbackUrl = `/activate%3Fuser_code=${userCode}`

	if (!session) {
		redirect(
			`/login?callbackUrl=${unAuthedCallbackUrl}&message=You must be logged in to activate your device.`,
		)
	}

	const verification = userCode
		? await db.query.deviceVerifications.findFirst({
				where: eq(deviceVerifications.userCode, userCode),
			})
		: null
	const grant = deviceGrantFromCode(verification?.deviceCode)
	if (!verification || !grant || verification.expires <= new Date())
		redirect('/activate/failure?message=Start device authorization again.')

	const consent = session.user?.id
		? mintDeviceConsent(userCode, verification.deviceCode, session.user.id)
		: null
	if (!consent)
		redirect('/activate/failure?message=Start device authorization again.')

	return (
		<LayoutClient withContainer>
			<Verify
				userCode={userCode}
				consent={consent}
				clientName={grant.clientName}
				scope={grant.scope}
			/>
		</LayoutClient>
	)
}
