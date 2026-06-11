'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { createAppAbility } from '@/ability'
import { Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { ArrowRightEndOnRectangleIcon } from '@heroicons/react/24/outline'
import { LogIn, Menu, X } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'

import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
	Button,
	Gravatar,
	Sheet,
	SheetContent,
} from '@coursebuilder/ui'
import { useFeedback } from '@coursebuilder/ui/feedback-widget/feedback-context'
import { cn } from '@coursebuilder/utils/cn'

import { CldImage } from '../cld-image'
import { NavLinkItem } from './nav-link-item'
import { ThemeToggle } from './theme-toggle'
import { useNavLinks } from './use-nav-links'

type MobileNavigationProps = {
	isMobileMenuOpen: boolean
	setIsMobileMenuOpen: React.Dispatch<React.SetStateAction<boolean>>
	subscriber?: Subscriber | null
}

/**
 * MobileNavigation component that handles the mobile menu, including user-related items
 */
export const MobileNavigation: React.FC<MobileNavigationProps> = ({
	isMobileMenuOpen,
	setIsMobileMenuOpen,
	subscriber,
}) => {
	const navData = useNavLinks()
	const { data: sessionData, status: sessionStatus } = useSession()
	const { setIsFeedbackDialogOpen } = useFeedback()
	const { data: abilityRules } = api.ability.getCurrentAbilityRules.useQuery()
	const ability = createAppAbility(abilityRules || [])

	const canViewTeam = ability.can('invite', 'Team')
	const canCreateContent = ability.can('create', 'Content')
	const canViewInvoice = ability.can('read', 'Invoice')
	const isAdmin = ability.can('manage', 'all')

	const userAvatar = sessionData?.user?.image ? (
		<Image
			src={sessionData.user.image}
			alt={sessionData.user.name || ''}
			width={48}
			height={48}
			className="rounded-full"
		/>
	) : (
		<Gravatar
			className="h-[48px] w-[48px] rounded-full"
			email={sessionData?.user?.email || ''}
			default="mp"
		/>
	)

	return (
		<div className="flex items-stretch lg:hidden">
			<Button
				variant="ghost"
				className="aspect-square h-[nav-height] items-center justify-center rounded-none border-l"
				type="button"
				onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
			>
				<Menu className="size-5" />
			</Button>
			<Sheet
				modal={false}
				onOpenChange={setIsMobileMenuOpen}
				open={isMobileMenuOpen}
			>
				<SheetContent
					side="right"
					className="bg-card overflow-y-auto px-0 py-5 pt-16 [&>button>svg]:h-7 [&>button>svg]:w-7 [&>button]:flex [&>button]:h-12 [&>button]:w-12 [&>button]:items-center [&>button]:justify-center"
				>
					<nav
						aria-label="Primary Mobile Navigation"
						className="flex h-full flex-col items-start justify-between gap-2"
					>
						<div className="flex w-full flex-col">
							{sessionStatus === 'authenticated' && (
								<div className="mb-4 flex w-full flex-row items-center gap-1 border-b px-5 py-5">
									{userAvatar}
									<span className="text-xl font-bold">
										{sessionData.user.name
											? `Hey there, ${sessionData.user.name?.split(' ')[0]}`
											: 'Hey there'}
									</span>
								</div>
							)}
							{sessionStatus === 'unauthenticated' && !subscriber && (
								<NavLinkItem
									href="/newsletter"
									className="[&_span]:flex [&_span]:items-center"
									label={
										<>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												className="mr-2 size-4"
												fill="none"
												viewBox="0 0 24 24"
											>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M6 8h8m-8 4h8m-8 4h4m8-8h1c1.414 0 2.121 0 2.56.44.44.439.44 1.146.44 2.56v8a2 2 0 1 1-4 0V8Z"
													className="text-primary"
												/>
												<path
													stroke="currentColor"
													strokeLinecap="round"
													strokeLinejoin="round"
													strokeWidth="1.5"
													d="M12 3H8c-2.828 0-4.243 0-5.121.879C2 4.757 2 6.172 2 9v6c0 2.828 0 4.243.879 5.121C3.757 21 5.172 21 8 21h12a2 2 0 0 1-2-2V9c0-2.828 0-4.243-.879-5.121C16.243 3 14.828 3 12 3Z"
												/>
											</svg>
											Newsletter
										</>
									}
								/>
							)}
							<NavLinkItem
								href={navData.browseAll.href}
								className="[&_span]:flex [&_span]:items-center"
								label={
									<>
										<svg
											xmlns="http://www.w3.org/2000/svg"
											className="mr-2 size-4"
											fill="none"
											viewBox="0 0 24 24"
										>
											<path
												stroke="currentColor"
												strokeLinecap="round"
												strokeWidth="1.5"
												d="M11.5 21c-4.478 0-6.718 0-8.109-1.391C2 18.217 2 15.979 2 11.5c0-4.478 0-6.718 1.391-8.109S7.021 2 11.5 2c4.478 0 6.718 0 8.109 1.391S21 7.021 21 11.5"
											/>
											<path
												stroke="currentColor"
												strokeLinejoin="round"
												strokeWidth="1.5"
												d="M2 7h19"
											/>
											<path
												stroke="currentColor"
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth="1.5"
												d="M10 16h1m-5 0h1"
												opacity=".4"
											/>
											<path
												stroke="currentColor"
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth="1.5"
												d="M10 12h4m-8 0h1"
											/>
											<path
												className="text-primary"
												stroke="currentColor"
												strokeLinecap="round"
												strokeLinejoin="round"
												strokeWidth="1.5"
												d="M20.4 20.4 22 22m-.8-4.4a3.6 3.6 0 1 0-7.2 0 3.6 3.6 0 0 0 7.2 0Z"
											/>
										</svg>
										Browse all
									</>
								}
							/>
							<Accordion
								type="multiple"
								defaultValue={['learn']}
								className="divide-border w-full divide-y"
							>
								{(navData.learn.courses.length > 0 ||
									navData.learn.freeTutorials.items.length > 0) && (
									<AccordionItem value="learn" className="border-none px-5">
										<AccordionTrigger className="h-9 items-center py-0 hover:no-underline">
											<div className="flex items-center gap-2">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													className="size-4"
													fill="none"
													viewBox="0 0 24 24"
												>
													<path
														stroke="currentColor"
														strokeLinejoin="round"
														strokeWidth="1.5"
														d="M14.453 12.895c-.151.627-.867 1.07-2.3 1.955-1.383.856-2.075 1.285-2.633 1.113a1.376 1.376 0 0 1-.61-.393c-.41-.45-.41-1.324-.41-3.07 0-1.746 0-2.62.41-3.07.17-.186.38-.321.61-.392.558-.173 1.25.256 2.634 1.112 1.432.886 2.148 1.329 2.3 1.955a1.7 1.7 0 0 1 0 .79Z"
													/>
													<path
														stroke="currentColor"
														strokeLinecap="round"
														strokeWidth="1.5"
														d="M20.998 11c.002.47.002.97.002 1.5 0 4.478 0 6.718-1.391 8.109C18.217 22 15.979 22 11.5 22c-4.478 0-6.718 0-8.109-1.391C2 19.217 2 16.979 2 12.5c0-4.478 0-6.718 1.391-8.109S7.021 3 11.5 3c.53 0 1.03 0 1.5.002"
													/>
													<path
														stroke="currentColor"
														strokeLinejoin="round"
														strokeWidth="1.5"
														d="m18.5 2 .258.697c.338.914.507 1.371.84 1.704.334.334.791.503 1.705.841L22 5.5l-.697.258c-.914.338-1.371.507-1.704.84-.334.334-.503.791-.841 1.705L18.5 9l-.258-.697c-.338-.914-.507-1.371-.84-1.704-.334-.334-.791-.503-1.705-.841L15 5.5l.697-.258c.914-.338 1.371-.507 1.704-.84.334-.334.503-.791.841-1.705L18.5 2Z"
														className="text-primary"
													/>
												</svg>
												<span className="text-base font-medium sm:text-sm">
													Courses & Tutorials
												</span>
												<span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums">
													{navData.learn.courses.length +
														navData.learn.freeTutorials.items.length +
														1}
												</span>
											</div>
										</AccordionTrigger>
										<AccordionContent className="pb-3 pt-2">
											{navData.learn.courses.length > 0 && (
												<div className="mb-3 flex flex-col">
													<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
														Courses
													</div>
													<ul className="-mx-5 flex flex-col">
														{navData.learn.courses.map((course) => (
															<li key={course.href}>
																<Link
																	href={course.href}
																	className="hover:bg-muted flex items-center gap-3 px-5 py-2 transition"
																>
																	<CldImage
																		src={course.image.src}
																		alt={course.image.alt}
																		width={48}
																		height={27}
																		className="shrink-0 rounded"
																	/>
																	<span className="text-sm font-medium">
																		{course.title}
																	</span>
																</Link>
															</li>
														))}
													</ul>
												</div>
											)}
											<div className="flex flex-col">
												<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
													Free Tutorials
												</div>
												<ul className="-mx-5 flex flex-col">
													<li>
														<Link
															href={navData.learn.freeTutorials.featured.href}
															className="hover:bg-muted flex items-center gap-3 px-5 py-2 transition"
														>
															{navData.learn.freeTutorials.featured.image && (
																<CldImage
																	src={
																		navData.learn.freeTutorials.featured.image
																			.src
																	}
																	alt={
																		navData.learn.freeTutorials.featured.image
																			.alt
																	}
																	width={48}
																	height={27}
																	className="shrink-0 rounded"
																/>
															)}
															<span className="text-sm font-medium">
																{navData.learn.freeTutorials.featured.title}
															</span>
														</Link>
													</li>
													{navData.learn.freeTutorials.items.map((tutorial) => (
														<li key={tutorial.href}>
															<Link
																href={tutorial.href}
																className="hover:bg-muted flex items-center gap-3 px-5 py-2 transition"
															>
																{tutorial.image && (
																	<Image
																		src={tutorial.image.src}
																		alt={tutorial.image.alt}
																		width={48}
																		height={27}
																		className="shrink-0 rounded"
																	/>
																)}
																<span className="text-sm font-medium">
																	{tutorial.title}
																</span>
															</Link>
														</li>
													))}
												</ul>
											</div>
										</AccordionContent>
									</AccordionItem>
								)}
								{(navData.live.events.length > 0 ||
									navData.live.pastEvents.length > 0 ||
									navData.live.cohorts.length > 0 ||
									navData.live.pastCohorts.length > 0) && (
									<AccordionItem value="live" className="border-none px-5">
										<AccordionTrigger className="h-9 items-center py-0 hover:no-underline">
											<div className="flex items-center gap-2">
												<svg
													xmlns="http://www.w3.org/2000/svg"
													className="size-4"
													fill="none"
													viewBox="0 0 24 24"
												>
													<path
														stroke="currentColor"
														strokeLinejoin="round"
														strokeWidth="1.5"
														d="M15.538 18.592c-1.107.908-2.75.908-6.038.908-3.287 0-4.931 0-6.038-.908a4 4 0 0 1-.554-.554C2 16.93 2 15.288 2 12c0-3.287 0-4.931.908-6.038a4 4 0 0 1 .554-.554C4.57 4.5 6.212 4.5 9.5 4.5c3.287 0 4.931 0 6.038.908a4 4 0 0 1 .554.554C17 7.07 17 8.712 17 12c0 3.287 0 4.931-.908 6.038a4.001 4.001 0 0 1-.554.554Z"
													/>
													<path
														stroke="currentColor"
														strokeLinejoin="round"
														strokeWidth="1.5"
														d="M17 13v-2l2.6-3.467a1.333 1.333 0 0 1 2.4.8v7.334a1.333 1.333 0 0 1-2.4.8L17 13Zm-7.5.5a1.5 1.5 0 0 0 0-3m0 3a1.5 1.5 0 0 1 0-3m0 3v-3"
														className="text-primary"
													/>
												</svg>
												<span className="text-base font-medium sm:text-sm">
													Live
												</span>
												{navData.live.events.length > 0 ||
												navData.live.cohorts.length > 0 ? (
													<span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums">
														{navData.live.events.length +
															navData.live.cohorts.length}{' '}
														upcoming
													</span>
												) : (
													<span className="text-muted-foreground bg-muted rounded-full px-2 py-0.5 text-[11px] font-medium">
														no upcoming
													</span>
												)}
											</div>
										</AccordionTrigger>
										<AccordionContent className="pb-3 pt-2">
											{(navData.live.cohorts.length > 0 ||
												navData.live.pastCohorts.length > 0) && (
												<div className="mb-3 flex flex-col">
													<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
														{navData.live.cohorts.length > 0
															? 'Upcoming Cohorts'
															: 'Cohorts'}
													</div>
													{navData.live.cohorts.length === 0 && (
														<div className="text-muted-foreground py-1 text-sm">
															No cohorts scheduled at the moment.
														</div>
													)}
													{navData.live.cohorts.length > 0 && (
														<ul className="-mx-5 flex flex-col">
															{navData.live.cohorts.map((cohort) => (
																<li key={cohort.href}>
																	<Link
																		href={cohort.href}
																		className="hover:bg-muted flex items-center gap-3 px-5 py-2 transition"
																	>
																		<CldImage
																			src={cohort.image.src}
																			alt={cohort.image.alt}
																			width={48}
																			height={27}
																			className="shrink-0 rounded"
																		/>
																		<div className="flex flex-col">
																			<span className="text-sm font-medium leading-tight">
																				{cohort.title}
																			</span>
																			<span className="text-muted-foreground text-xs">
																				{cohort.subtitle}
																			</span>
																		</div>
																	</Link>
																</li>
															))}
														</ul>
													)}
													{navData.live.pastCohorts.length > 0 && (
														<div className="mt-2">
															<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
																Past Cohorts
															</div>
															<ul className="-mx-5 flex flex-col">
																{navData.live.pastCohorts.map((cohort) => (
																	<li key={cohort.href}>
																		<Link
																			href={cohort.href}
																			className="hover:bg-muted flex items-center gap-3 px-5 py-2 opacity-60 transition hover:opacity-100"
																		>
																			<CldImage
																				src={cohort.image.src}
																				alt={cohort.image.alt}
																				width={40}
																				height={23}
																				className="shrink-0 rounded"
																			/>
																			<div className="flex flex-col">
																				<span className="text-sm leading-tight">
																					{cohort.title}
																				</span>
																				<span className="text-muted-foreground text-xs">
																					{cohort.subtitle}
																				</span>
																			</div>
																		</Link>
																	</li>
																))}
															</ul>
														</div>
													)}
												</div>
											)}
											{(navData.live.events.length > 0 ||
												navData.live.pastEvents.length > 0) && (
												<div className="flex flex-col">
													<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
														{navData.live.events.length > 0
															? 'Upcoming Events'
															: 'Events'}
													</div>
													{navData.live.events.length === 0 && (
														<div className="text-muted-foreground py-1 text-sm">
															No events scheduled at the moment.
														</div>
													)}
													{navData.live.events.length > 0 && (
														<ul className="-mx-5 flex flex-col">
															{navData.live.events.map((event) => (
																<li key={event.href}>
																	<Link
																		href={event.href}
																		className="hover:bg-muted flex items-center gap-3 px-5 py-2 transition"
																	>
																		<CldImage
																			src={event.image.src}
																			alt={event.image.alt}
																			width={48}
																			height={27}
																			className="shrink-0 rounded"
																		/>
																		<div className="flex flex-col">
																			<span className="text-sm font-medium leading-tight">
																				{event.title}
																			</span>
																			<span className="text-muted-foreground text-xs">
																				{event.date}
																			</span>
																		</div>
																	</Link>
																</li>
															))}
														</ul>
													)}
													{navData.live.pastEvents.length > 0 && (
														<div className="mt-2">
															<div className="text-muted-foreground mb-1.5 text-[11px] font-medium uppercase tracking-wider">
																Past Events
															</div>
															<ul className="-mx-5 flex flex-col">
																{navData.live.pastEvents.map((event) => (
																	<li key={event.href}>
																		<Link
																			href={event.href}
																			className="hover:bg-muted flex items-center gap-3 px-5 py-2 opacity-60 transition hover:opacity-100"
																		>
																			<CldImage
																				src={event.image.src}
																				alt={event.image.alt}
																				width={40}
																				height={23}
																				className="shrink-0 rounded"
																			/>
																			<div className="flex flex-col">
																				<span className="text-sm leading-tight">
																					{event.title}
																				</span>
																				<span className="text-muted-foreground text-xs">
																					{event.date}
																				</span>
																			</div>
																		</Link>
																	</li>
																))}
															</ul>
														</div>
													)}
												</div>
											)}
										</AccordionContent>
									</AccordionItem>
								)}
							</Accordion>
							<ul className="mt-4 flex flex-col border-t px-5 pt-1">
								{sessionStatus === 'authenticated' && (
									<NavLinkItem
										className="pl-0 text-sm"
										label="Send Feedback"
										onClick={() => setIsFeedbackDialogOpen(true)}
									/>
								)}
								{canViewTeam && !isAdmin && (
									<NavLinkItem
										className="pl-0 text-sm"
										label="Invite Team"
										href="/team"
									/>
								)}
								{canViewInvoice && (
									<NavLinkItem
										className="pl-0 text-sm"
										href="/invoices"
										label="Invoices"
									/>
								)}
								{sessionStatus === 'authenticated' && (
									<NavLinkItem
										className="pl-0 text-sm"
										href="/profile"
										label="Profile"
									/>
								)}
								{canCreateContent && (
									<NavLinkItem
										className="pl-0 text-sm"
										href="/admin/pages"
										label="Admin"
									/>
								)}
							</ul>
						</div>

						<div className="flex w-full flex-col items-start justify-start border-t pt-3">
							{sessionStatus === 'unauthenticated' && (
								<NavLinkItem
									href="/login"
									label="Log in"
									icon={<LogIn className="mr-2 size-4" />}
									className="[&_span]:flex [&_span]:items-center"
								/>
							)}
							{sessionStatus === 'authenticated' && (
								<NavLinkItem
									href="#"
									label="Log out"
									onClick={() => signOut()}
									icon={
										<ArrowRightEndOnRectangleIcon className="mr-2 h-4 w-4" />
									}
									className="[&_span]:flex [&_span]:items-center"
								/>
							)}
							<ThemeToggle className="text-sm [&_svg]:h-5 [&_svg]:w-5" />
						</div>
					</nav>
				</SheetContent>
			</Sheet>
		</div>
	)
}
