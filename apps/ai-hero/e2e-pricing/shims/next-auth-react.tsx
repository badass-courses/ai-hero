import type * as React from 'react'

// Signed-out buyer: coupon links must price without a session.
export const useSession = () => ({ status: 'unauthenticated', data: null })
export const SessionProvider = ({ children }: { children: React.ReactNode }) =>
	children
