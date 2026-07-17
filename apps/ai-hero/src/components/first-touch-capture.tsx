'use client'

import { useEffect } from 'react'
import { useConvertkitSubscriberUrlParam } from '@/hooks/use-convertkit-subscriber-url-param'
import { captureFirstTouch } from '@/utils/first-touch'

export function FirstTouchCapture() {
	useConvertkitSubscriberUrlParam()
	useEffect(() => {
		captureFirstTouch()
	}, [])

	return null
}
