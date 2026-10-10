# Post-purchase waiting flow

The thank-you page, server loading states, login-link handoff and welcome page now use the same shell. It reuses the app's tokens and Course Builder Progress, Skeleton, Alert and Button components.

The waiting lifecycle is `checking.polling → checking.waiting → checking.polling`, then `ready` or `failed`. Slow copy appears after 10 seconds. The 90-second deadline also cancels a stalled request. Retry starts a fresh deadline. Failure stops the skeleton animation and focuses the support heading. Completion focuses the real destination heading. Reduced-motion preferences disable animation and the short cross-fade delay.

## Three regression fixes

- Timeout no longer leaves a spinner beside the error. The failed shell has static placeholders, retry and support actions.
- Removed `payment_succeeded_processing_failed` from the polling contract. A database miss does not prove a Stripe payment failed. The status route stays database-only; the server's separate Stripe-evidence fallback remains.
- A post-retry purchase miss now returns a support state, not a 404. Malformed session IDs still return 404. Copy says payment is confirmed only after purchase or Stripe evidence exists.

## Navigation and telemetry

Hard navigation remains. A signed-out purchase visitor needs the login-link branch; client navigation directly to welcome must not bypass session and ownership checks. The new-account session-cookie risk is not cleared for soft navigation.

The four telemetry call sites match `createBuyPathLogger(checkoutSessionId)`: an emitter takes `client_returned`, `client_polling`, `purchase_visible` or `destination_rendered`, plus optional `attempt`, `durationMs` and `outcome` (`ok`, `failed` or `skipped`). Wiring the companion helper is a one-line factory export swap. This change creates neither its own logger nor its own identifier, timing or transport.

The checkout-session key travels to welcome as telemetry-only `buyPathId`, not `session_id`, so it does not trigger another Stripe lookup or grant access. The waited marker prevents the destination from repeating the two observations already emitted by a mounted poller. Fast purchases that never mount the poller record those observations on destination mount. The adapter is intentionally inactive until the companion client helper backs it. Do not count these call sites as live telemetry yet.

## Verification

Typecheck, changed-file ESLint and 34 relevant Vitest tests passed. Browser checks found no accessibility violations in the failed shell or welcome section. The mobile ready-shell preview had no horizontal overflow. Reduced-motion and failure frames had no active skeleton animations.

Before updating the branch base, the sandbox checkout CLI's hosted-card automation failed. The same hosted test checkout was completed with agent-browser instead. Independent commerce-rig `provesAccess` readback confirmed a paid test session, stored webhook, matching purchase and entitlement. The signed-out browser reached the login-link shell. A synthetic authenticated session reached welcome and focused its heading.

After updating to main's admin-flag change, a fresh `checkout new-buyer --complete` is blocked before Stripe: the rig has no working flag backend, so checkout fails closed with `kill-switch` and `c5.pricing.flag_read_failed`. No checkout or pricing gate was weakened. The complete two-buyer sandbox proof on the current base is still held. The earlier payment proof is not proof of the current base or of a new-account session-cookie handoff.

All screenshots use synthetic data. No production checkout, provider configuration or database writes were performed. Development toolbars are hidden in the screenshots; app content is unchanged.

## Frames

### Processing

![Processing](screenshots/frame-processing-light.png)

### Slow processing

![Slow processing](screenshots/frame-slow-light.png)

### Ready to navigate, component preview

This frame mounts the real shell with synthetic ready-state props. It is a UI preview, not a checkout or entitlement proof.

![Ready shell preview](screenshots/frame-ready-preview.png)

### Login-link handoff, signed out

![Login-link handoff](screenshots/frame-login-light.png)

### Welcome, authenticated

![Welcome](screenshots/frame-welcome-light.png)

### Failed check, with focus and support actions

This is the actual 90-second timeout on a synthetic missing checkout session, not a forced error prop.

![Failure](screenshots/frame-failed-light.png)

### Dark theme, failed check

![Dark failure](screenshots/frame-failed-dark.png)

### Mobile ready-shell preview

![Mobile ready shell](screenshots/frame-ready-mobile-preview.png)
