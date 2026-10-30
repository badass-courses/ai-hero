/**
 * Backtick spans in plain authored text (quiz questions and choices), set as
 * the prose's own code chips. Nothing else in the text is markdown.
 */
export function InlineCode({ text }: { text: string }) {
	return (
		<>
			{text.split(/(`[^`]+`)/g).map((part, index) =>
				part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
					<code key={index} className="ah-code-inline">
						{part.slice(1, -1)}
					</code>
				) : (
					part
				),
			)}
		</>
	)
}
