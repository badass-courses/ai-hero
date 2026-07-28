export function sanitizeMdxSource(source: string) {
	return source.replace(/<!--[\s\S]*?-->/g, '')
}
