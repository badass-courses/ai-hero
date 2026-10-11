/** Browser-facing origin. Never trust Host or Forwarded request headers. */
export function buyPathOrigin(config: {
	publicUrl?: string
	vercelEnvironment?: string
	vercelDeploymentHost?: string
}): string | null {
	// COURSEBUILDER_URL is rewritten to the production project URL even on
	// previews. A preview must instead bind to its own platform-assigned host.
	const value =
		config.vercelEnvironment === 'preview'
			? config.vercelDeploymentHost
				? `https://${config.vercelDeploymentHost}`
				: null
			: config.publicUrl
	if (!value) return null
	try {
		const url = new URL(value)
		if (
			!['http:', 'https:'].includes(url.protocol) ||
			url.username ||
			url.password
		)
			return null
		if (
			config.vercelEnvironment === 'preview' &&
			url.host !== config.vercelDeploymentHost
		)
			return null
		return url.origin
	} catch {
		return null
	}
}
