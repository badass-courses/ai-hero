'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { Icon } from '@/components/brand/icons'
import { HeroShader } from '@/components/landing/hero-shader'
import { env } from '@/env.mjs'
import { Provider } from '@/server/auth'
import { MailIcon } from 'lucide-react'
import { signIn } from 'next-auth/react'
import { useForm } from 'react-hook-form'
import toast from 'react-hot-toast'
import Balancer from 'react-wrap-balancer'

import { Button, Input, Label } from '@coursebuilder/ui'

export type LoginTemplateProps = {
	providers: Record<string, Provider> | null
	image?: React.ReactElement
	title?: string
	subtitle?: string
	callbackUrl?: string
	className?: string
}

type LoginErrorInfo = {
	title: string
	message: string
}

export function getLoginErrorInfo(error: string | null): LoginErrorInfo | null {
	switch (error) {
		case 'OAuthCallback':
		case 'OAuthCallbackError':
			return {
				title: "Sign-in couldn't be completed",
				message:
					'Try GitHub or Discord again, or choose a different sign-in method.',
			}
		case 'OAuthAccountNotLinked':
		case 'AccountNotLinked':
			return {
				title: 'Account not connected',
				message: 'Sign in with email first, then connect your provider.',
			}
		case 'MissingCSRF':
			return {
				title: 'Sign-in expired',
				message: 'Reload this page and try again.',
			}
		default:
			return null
	}
}

export function getLoginMessageInfo(
	message: string | null,
): LoginErrorInfo | null {
	switch (message) {
		case 'Please log in first to connect Discord':
			return {
				title: 'Login required',
				message: 'Log in before connecting Discord.',
			}
		case 'Log in to manage Discord roles':
			return {
				title: 'Login required',
				message: 'Log in before managing Discord roles.',
			}
		default:
			return null
	}
}

export const Login: React.FC<React.PropsWithChildren<LoginTemplateProps>> = ({
	providers = {},
	image,
	title,
	subtitle,
	callbackUrl: callbackUrlProp,
	className,
}) => {
	const {
		register,
		handleSubmit,
		formState: { isSubmitting },
	} = useForm<{ email: string }>()

	const searchParams = useSearchParams()

	const callbackUrl = callbackUrlProp
		? callbackUrlProp
		: searchParams.get('callbackUrl')
			? (searchParams.get('callbackUrl') as string)
			: '/'

	const message = searchParams.get('message')
		? (searchParams.get('message') as string)
		: null
	const error = searchParams.get('error')
		? (searchParams.get('error') as string)
		: null

	const errorInfo = getLoginErrorInfo(error)
	const messageInfo = getLoginMessageInfo(message)
	const alertInfo = errorInfo ?? messageInfo

	React.useEffect(() => {
		const currentInfo = getLoginErrorInfo(error) ?? getLoginMessageInfo(message)
		if (currentInfo) {
			toast.error(`${currentInfo.title}. ${currentInfo.message}`, {
				icon: '⛔️',
				duration: 8000,
			})
		}
	}, [message, error])

	const githubProvider = providers?.github
	const discordProvider = providers?.discord
	const emailProvider = providers?.postmark
	const submitEmailSignIn = handleSubmit(async ({ email }) => {
		if (!emailProvider) return

		await signIn(emailProvider.id, {
			email: email.trim(),
			callbackUrl,
		})
	})

	return (
		<main data-login-template="" className={className}>
			<div aria-hidden data-login-background="">
				<HeroShader
					speed={0.2}
					frequency={7.0}
					displacement={0.018}
					displacementFreq={4.5}
					mouseFollow={0.03}
					mouseInfluence={0.55}
					flowY={0.2}
					flowX={0.2}
					intensity={1.0}
					saturation={1.25}
					sharpness={0.7}
					grain={0.1}
					grainTexture={0.3}
					grainScale={0.5}
					chromaOffset={13.0}
					vignette={0}
					mouseHalo={0.15}
					posterize={0.1}
					colorDrift={0.05}
					seed={10}
				/>
				{/* <div data-login-background-fade="" /> */}
			</div>
			<div data-login-card="">
				{image ? image : null}
				<h1 data-title="">
					{title ? title : `Log in`}
					{subtitle && <span data-subtitle="">{subtitle}</span>}
				</h1>
				{alertInfo ? (
					<div
						role="alert"
						className="border-destructive/30 bg-destructive/10 mb-6 rounded-md border p-4 text-left"
					>
						<p className="font-semibold">{alertInfo.title}</p>
						<p className="text-muted-foreground mt-1 text-sm">
							{alertInfo.message}
						</p>
					</div>
				) : null}
				{error === 'Verification' ? (
					<p data-verification-error="">
						<Balancer>
							That sign in link is no longer valid. It may have been used
							already or it may have expired. Please request a new log in link
							below.{' '}
							<a
								className="text-primary underline"
								href={`mailto:${env.NEXT_PUBLIC_SUPPORT_EMAIL}`}
							>
								Click here to email us
							</a>{' '}
							if you need help.
						</Balancer>
					</p>
				) : null}

				<div data-providers-container="">
					{discordProvider ? (
						<Button
							data-button=""
							variant="outline"
							onClick={() =>
								signIn(discordProvider.id, {
									callbackUrl,
								})
							}
						>
							<Icon
								className="mr-2 flex items-center justify-center"
								name="Discord"
								size="20"
							/>
							Sign in with existing {discordProvider.name} account
						</Button>
					) : null}
					{githubProvider ? (
						<Button
							data-button=""
							variant="outline"
							onClick={() =>
								signIn(githubProvider.id, {
									callbackUrl,
								})
							}
						>
							<svg
								width={20}
								height={20}
								viewBox={'0 0 16 16'}
								role={'img'}
								className="mr-2 flex items-center justify-center"
								xmlns="http://www.w3.org/2000/svg"
							>
								<title>{'Github'}</title>
								<path
									fillRule="evenodd"
									clipRule="evenodd"
									fill="currentColor"
									d="M8,0.2c-4.4,0-8,3.6-8,8c0,3.5,2.3,6.5,5.5,7.6 C5.9,15.9,6,15.6,6,15.4c0-0.2,0-0.7,0-1.4C3.8,14.5,3.3,13,3.3,13c-0.4-0.9-0.9-1.2-0.9-1.2c-0.7-0.5,0.1-0.5,0.1-0.5 c0.8,0.1,1.2,0.8,1.2,0.8C4.4,13.4,5.6,13,6,12.8c0.1-0.5,0.3-0.9,0.5-1.1c-1.8-0.2-3.6-0.9-3.6-4c0-0.9,0.3-1.6,0.8-2.1 c-0.1-0.2-0.4-1,0.1-2.1c0,0,0.7-0.2,2.2,0.8c0.6-0.2,1.3-0.3,2-0.3c0.7,0,1.4,0.1,2,0.3c1.5-1,2.2-0.8,2.2-0.8 c0.4,1.1,0.2,1.9,0.1,2.1c0.5,0.6,0.8,1.3,0.8,2.1c0,3.1-1.9,3.7-3.7,3.9C9.7,12,10,12.5,10,13.2c0,1.1,0,1.9,0,2.2 c0,0.2,0.1,0.5,0.6,0.4c3.2-1.1,5.5-4.1,5.5-7.6C16,3.8,12.4,0.2,8,0.2z"
								/>
							</svg>
							Sign in with existing {githubProvider.name} account
						</Button>
					) : null}
				</div>
				{(githubProvider || discordProvider) && (
					<div data-separator="">
						<div className="bg-border absolute left-1/2 h-px w-full -translate-x-1/2" />
						<span className="bg-background text-muted-foreground relative z-10 px-4 text-sm">
							or
						</span>
					</div>
				)}
				{emailProvider ? (
					<form data-form="" method="post" onSubmit={submitEmailSignIn}>
						<Label data-label="" htmlFor="email">
							Email address
						</Label>
						<div data-input-container="">
							<div data-icon="">
								{/* <svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 20 20"
									fill="currentColor"
									aria-hidden="true"
								>
									<path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
									<path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
								</svg> */}
								<MailIcon
									strokeWidth={1.5}
									className="text-muted-foreground size-5"
								/>
							</div>
							<Input
								data-input=""
								id="email"
								type="email"
								required={true}
								placeholder="you@example.com"
								{...register('email', { required: true })}
							/>
						</div>
						<Button
							type="submit"
							data-button=""
							disabled={isSubmitting}
							className="relative overflow-hidden"
						>
							<span>
								{isSubmitting ? 'Sending login link…' : 'Email me a login link'}
							</span>
							<div
								style={{
									backgroundSize: '200% 100%',
								}}
								className="animate-shine absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0)40%,rgba(255,255,255,1)50%,rgba(255,255,255,0)60%)] opacity-10 dark:opacity-20"
							/>
						</Button>
					</form>
				) : null}
			</div>
		</main>
	)
}
