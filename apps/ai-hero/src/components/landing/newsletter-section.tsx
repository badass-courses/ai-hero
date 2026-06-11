import * as React from 'react'

export function NewsletterSection({
	heading,
	subTitle,
	children,
}: {
	heading?: string
	subTitle?: string
	children: React.ReactNode
}) {
	return (
		<section className="border-border relative flex flex-col items-center border-b">
			<div className="flex w-full max-w-4xl flex-col items-center gap-16 px-8 py-24 sm:px-16">
				<div className="flex flex-col items-center gap-4">
					{heading && (
						<h2 className="text-balance text-center font-sans text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
							{heading}
						</h2>
					)}
					{subTitle && (
						<p className="text-balance text-center font-sans text-base font-normal leading-tight opacity-80 sm:text-lg">
							{subTitle}
						</p>
					)}
				</div>
				{children}
			</div>
			<div
				aria-hidden
				className="h-1.5 w-full bg-[url('/landing/colorful-stripe.jpg')] bg-contain bg-center bg-no-repeat sm:h-3"
			/>
		</section>
	)
}
