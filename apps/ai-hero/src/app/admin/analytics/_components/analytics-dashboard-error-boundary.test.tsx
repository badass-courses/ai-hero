import React from 'react'
import { describe, expect, it } from 'vitest'

import { AnalyticsDashboardErrorBoundary } from './analytics-dashboard-error-boundary'

describe('analytics dashboard render boundary', () => {
	it('exposes a retryable fallback for an unexpected shared-tree crash', () => {
		const boundary = new AnalyticsDashboardErrorBoundary({ children: null })
		boundary.state = AnalyticsDashboardErrorBoundary.getDerivedStateFromError()

		const fallback = boundary.render() as React.ReactElement<{
			role?: string
			children?: React.ReactNode
		}>

		expect(fallback.props.role).toBe('alert')
		expect(fallback.props.children).toBeTruthy()
	})
})
