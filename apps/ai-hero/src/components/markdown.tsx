import ReactMarkdown, { type Options } from 'react-markdown'
import { rehypeInternalLinks } from '@/utils/rehype-internal-links'

/**
 * Site-standard `react-markdown`: the library component plus the same
 * internal-link rewriting the article pipeline applies (see
 * `rehype-internal-links.ts`), so an authored `https://aihero.dev/...` link
 * renders as a root-relative `/...` everywhere, not just in MDX bodies.
 *
 * Import this instead of `react-markdown` for any user-facing markdown.
 * Caller plugins run first — after e.g. `rehype-raw` expands embedded HTML,
 * the rewrite still sees the anchors it produced.
 */
export function Markdown({ rehypePlugins, ...props }: Options) {
	return (
		<ReactMarkdown
			{...props}
			rehypePlugins={[...(rehypePlugins ?? []), rehypeInternalLinks]}
		/>
	)
}
