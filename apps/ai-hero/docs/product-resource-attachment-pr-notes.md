# PR notes: product-resource attachment API

`POST /api/products/{productId}/resources` accepts an existing resource ID from an authorized device token. It uses the CMS attachment persistence and cache invalidation. Re-attaching the same pair returns its existing position, including when concurrent inserts race on the join primary key.

**Known pre-existing limitation:** concurrent attachments of *different* resources to one product can each count the same siblings and receive the same position. The CMS action has the same race. Position allocation is not serialized in this change.

Verification: content API route tests, OpenAPI tests, app typecheck, and targeted ESLint.
