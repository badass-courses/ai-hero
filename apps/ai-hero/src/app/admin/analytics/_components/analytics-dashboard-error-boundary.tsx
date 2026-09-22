'use client'

import React from 'react'

import { AnalyticsAgentApiCard } from './analytics-agent-api-card'

type Props = {
	children: React.ReactNode
	/** Keep the app-owned copy control available if the shared tree crashes. */
	fallback?: React.ReactNode
}

type State = { hasError: boolean }

/**
 * Boundary for the composed analytics dashboard subtree, not individual
 * provider cards. Section request failures stay in the parent retry controls.
 */
export class AnalyticsDashboardErrorBoundary extends React.Component<
	Props,
	State
> {
	state: State = { hasError: false }

	static getDerivedStateFromError(): State {
		return { hasError: true }
	}

	render() {
		if (!this.state.hasError) return this.props.children

		return (
			<div
				role="alert"
				className="border-destructive/40 bg-destructive/5 flex flex-col gap-3 rounded-xl border p-4"
			>
				<div>
					<h2 className="font-semibold">Analytics could not render.</h2>
					<p className="text-muted-foreground text-sm">
						The dashboard view failed unexpectedly. Your section retry controls
						remain above, and you can still copy the agent prompt below.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={() => this.setState({ hasError: false })}
						className="text-foreground text-sm font-medium underline underline-offset-2"
					>
						Try dashboard again
					</button>
					{this.props.fallback ?? <AnalyticsAgentApiCard />}
				</div>
			</div>
		)
	}
}
