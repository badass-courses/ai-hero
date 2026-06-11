import React from 'react'
import Markdown from 'react-markdown'

function BeforeIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.5"
				d="M12.31 3h-.62c-2.436 0-3.654 0-4.65.553-.997.552-1.588 1.555-2.771 3.562l-.59 1C2.56 10.014 2 10.963 2 12s.56 1.986 1.68 3.885l.589 1c1.183 2.007 1.774 3.01 2.77 3.563.997.552 2.215.552 4.65.552h.622c2.435 0 3.653 0 4.65-.552.996-.553 1.587-1.556 2.77-3.563l.59-1C21.44 13.986 22 13.037 22 12s-.56-1.986-1.68-3.885l-.589-1c-1.183-2.007-1.774-3.01-2.77-3.562C15.963 3 14.745 3 12.31 3Z"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="2"
				d="M11.992 16h.009"
			/>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M11.992 13V8"
			/>
		</svg>
	)
}

function AfterIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<path
				fill="currentColor"
				d="m20.25 6.644-.939.352c-1.058.397-2.22 1.223-3.396 2.314-1.165 1.081-2.287 2.37-3.272 3.619a52.64 52.64 0 0 0-2.404 3.32c-.294.441-.762 1.185-.92 1.436l-.94 1.565-.81-1.637c-.677-1.368-1.446-2.128-2.006-2.54-.282-.207-.625-.406-.854-.47l-.958-.242.485-1.96.97.244c.6.149 1.128.497 1.533.795.543.399 1.16.979 1.753 1.813l.088-.132a54.609 54.609 0 0 1 2.498-3.45c1.023-1.298 2.217-2.672 3.484-3.849 1.256-1.165 2.642-2.191 4.054-2.72l.937-.352.696 1.894Z"
			/>
		</svg>
	)
}

function MarkdownCell({ children }: { children: string }) {
	return (
		<div className="prose-sm dark:prose-invert prose lg:prose-base prose-p:m-0 prose-a:text-primary text-sm">
			<Markdown>{children}</Markdown>
		</div>
	)
}

export function CompareTable({
	before,
	after,
	children,
}: {
	before: string
	after: string
	children: React.ReactNode
}) {
	const rows = React.Children.toArray(children)
		.filter(React.isValidElement<{ before: string; after: string }>)
		.map((child) => ({
			before: child.props.before,
			after: child.props.after,
		}))

	return (
		<div className="not-prose shadow-md/3 my-6 overflow-hidden rounded-xl border">
			{/* Desktop: side-by-side grid */}
			<div className="hidden sm:block">
				<div className="border-border grid grid-cols-2 border-b">
					<div className="bg-linear-to-r to-background border-r from-amber-200/10 px-4 py-3 text-sm font-medium text-black sm:text-base dark:from-amber-700/10 dark:text-white">
						<span className="dark:text-primary text-amber-600">Before:</span>{' '}
						{before}
					</div>
					<div className="bg-linear-to-r to-background from-emerald-200/10 px-4 py-3 text-sm font-medium text-black sm:text-base dark:from-emerald-700/10 dark:text-white">
						<span className="text-emerald-600 dark:text-emerald-300">
							After:
						</span>{' '}
						{after}
					</div>
				</div>
				<div className="divide-y">
					{rows.map((row, i) => (
						<div key={i} className="bg-card grid grid-cols-2">
							<div className="border-r px-4 py-3">
								<div className="flex items-baseline gap-1.5">
									<BeforeIcon className="dark:text-primary relative size-4 shrink-0 translate-y-0.5 text-amber-600" />
									<MarkdownCell>{row.before}</MarkdownCell>
								</div>
							</div>
							<div className="px-4 py-3">
								<div className="flex items-baseline gap-1.5">
									<AfterIcon className="relative size-4 shrink-0 translate-y-0.5 text-emerald-600 dark:text-emerald-300" />
									<MarkdownCell>{row.after}</MarkdownCell>
								</div>
							</div>
						</div>
					))}
				</div>
			</div>

			{/* Mobile: all befores, then all afters */}
			<div className="sm:hidden">
				<div className="bg-linear-to-r to-background from-amber-200/10 px-4 py-3 text-sm font-medium text-black dark:from-amber-700/5 dark:text-white">
					<span className="dark:text-primary text-amber-600">Before:</span>{' '}
					{before}
				</div>
				<div className="divide-y">
					{rows.map((row, i) => (
						<div key={i} className="bg-card px-4 py-3">
							<div className="flex items-baseline gap-1.5">
								<BeforeIcon className="dark:text-primary relative size-4 shrink-0 translate-y-0.5 text-amber-600" />
								<MarkdownCell>{row.before}</MarkdownCell>
							</div>
						</div>
					))}
				</div>
				<div className="bg-linear-to-r to-background border-t from-emerald-200/10 px-4 py-3 text-sm font-medium text-black dark:from-emerald-700/5 dark:text-white">
					<span className="text-emerald-600 dark:text-emerald-300">After:</span>{' '}
					{after}
				</div>
				<div className="divide-y">
					{rows.map((row, i) => (
						<div key={i} className="bg-card px-4 py-3">
							<div className="flex items-baseline gap-1.5">
								<AfterIcon className="relative size-4 shrink-0 translate-y-0.5 text-emerald-600 dark:text-emerald-300" />
								<MarkdownCell>{row.after}</MarkdownCell>
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	)
}

export function CompareRow(_props: { before: string; after: string }) {
	return null
}
