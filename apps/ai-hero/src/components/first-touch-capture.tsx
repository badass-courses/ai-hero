'use client'

import { useEffect } from 'react'
import { captureFirstTouch } from '@/utils/first-touch'

export function FirstTouchCapture() {
	useEffect(() => {
		captureFirstTouch()
	}, [])

	return null
}
