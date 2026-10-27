# Preview commerce environments

**Recommendation: finish the local paid-checkout proof first. Then pilot one isolated commerce preview before automating every PR.** Preview checkout needs both a non-production database and Stripe test credentials. Changing only one still leaves an unsafe mixed environment.

This is an option analysis, not a deployment plan or provider change. No Vercel variables, database branches, webhook endpoints or marketplace installations were changed.

| Option | What it gives us | Work and risks |
| --- | --- | --- |
| Per-preview PlanetScale development branch | Production-compatible schema with isolated writes and resettable synthetic fixtures | Create a schema-only branch, issue its own credential, push the preview schema and seed it. Do not copy production rows. Branch quotas, cost, concurrent schema work and credential/branch cleanup need an owner. Use an isolated Inngest environment as well. |
| Preview-scoped Stripe test keys | Real test Checkout, settings and payment transport without live charges | Scope keys to Preview, not all environments. A shared named sandbox is simple but needs per-run tags and cleanup. Per-preview sandboxes offer stronger isolation but create more provisioning and lifecycle work. Reject live keys and verify `livemode=false` responses regardless of the environment label. |
| Webhooks to protected preview URLs | Exercises real delivery and fulfillment in the deployed app | Stripe needs an externally reachable endpoint. Vercel Deployment Protection usually prevents unauthenticated webhook delivery. Use a narrow supported exemption or an automation-bypass mechanism, while still verifying Stripe signatures. Treat any bypass secret as a credential; do not commit it or put it in public receipt URLs. Test the exact URL after deployment. |
| Vercel environment scoping | Keeps Preview database/provider credentials separate from Production and Development | Confirm project, environment and branch-specific overrides. Preview-wide credentials may be shared by multiple branches. Scope non-commerce providers too, disable customer messaging, and redeploy after env changes. Inspect the deployed app's environment identity without exposing values. |
| Vercel Stripe marketplace integration | Can provision/manage sandbox keys through the platform integration instead of copying them by hand | Evaluate the [Stripe marketplace integration](https://vercel.com/marketplace/stripe) as the provisioning path. Verify its actual resource-to-environment mapping: distinct Production/Preview keys does not automatically mean a distinct sandbox for every PR. Confirm whether it provisions webhook endpoints/signing secrets, handles protected preview URLs, cleans up removed previews, and exposes variables with names this app consumes. This app currently expects `STRIPE_SECRET_TOKEN` and `STRIPE_WEBHOOK_SECRET`; integration-provided names may need explicit mapping. |

## Smallest useful pilot

1. Reserve one schema-only development database branch and one test sandbox for a commerce preview.
2. Assign preview-only credentials, isolated local/test jobs, and no customer-message credentials. Verify that Production and Development keep their existing configuration.
3. Configure the deployed Stripe webhook route, `/api/coursebuilder/webhook/stripe`, with the sandbox's signing secret and a narrow protection arrangement. The local CLI listener's `whsec` is not the deployed endpoint's secret.
4. Load only synthetic fixtures. Use the same paid receipt requirements as the rig: session total, paid status, matching webhook, purchase and access provenance.
5. Exercise reset and cleanup before expanding to per-PR provisioning. Make teardown part of preview closure, not a manual dashboard memory.

The marketplace integration may remove the key-copying step. It does not by itself isolate the database, messaging, jobs or price configuration. A stable seeded catalog and complete fact adapters remain necessary. Neither local test totals nor a successful low-value transport payment proves production C5 prices.

Useful references: [Vercel environment variables](https://vercel.com/docs/environment-variables), [Deployment Protection](https://vercel.com/docs/deployment-protection), [Stripe marketplace](https://vercel.com/marketplace/stripe), [PlanetScale branching](https://planetscale.com/docs/concepts/branching), [Stripe sandboxes](https://docs.stripe.com/sandboxes).

Check current provider limits and integration behavior during the pilot. These options do not authorize installing an integration or changing any environment.
