# AI Hero

The Next.js app behind [aihero.dev](https://www.aihero.dev) — courses, skills, and posts on AI engineering by Matt Pocock. Built on the Course Builder stack: Next.js App Router, tRPC, Drizzle on PlanetScale, NextAuth, Inngest for background workflows, and Mux for video.

## Local Setup

This app can be run locally. It requires API keys for many 3rd-party services. You can get an idea of what those are from the `.env.example` file. If you have access to the Course Builder project in Vercel, you'll be able to _pull_ most of these environment variables from there. Otherwise, you'll have to set up accounts with each of the services as needed.

### Env Vars from Vercel

For those with access to the project in Vercel, here is how to grab those env vars. 

**NOTE: you'll want to make sure you've `cd`'d into `<project-root>/apps/ai-hero` for this**:

- 1. Make sure you are signed in to the Vercel CLI
  - `vercel login`
- 2. Is the app/project cloned on your machine __linked__ to the corresponding project on Vercel?
  - Run `vercel env pull` and if not, it will say, `Error: Your codebase isn’t linked to a project on Vercel. Run 'vercel link' to begin.`
- 3. Link your local project to the project on Vercel
  - This step always seems like it is about to setup a fresh deployment of the app. Just make sure to carefully answer the prompts.
  - `vercel link`
    - "Set up `path/to/your/project`?" **Yes**
    - "Which scope should contain your project?" **Skill Recordings**
    - "Link to existing project?" **Yes** (note, default is No here)
    - "What's the name of your existing project?" **ai-hero** (check in the Vercel dashboard for the exact name of whatever project it is)
- 4. Pull the environment variables from Vercel
  - `vercel env pull`
  - At this point, the vercel CLI will have created a `.env.local` file with all of the `development` environment variables.
    - If for some reason you are needing environment variables for a different environment, you can include the `--environment` flag in the above command like so:
      - `vercel env pull --environment=preview`

_Note: Because of [Next.js Enviornment Variable Load Order](https://nextjs.org/docs/pages/building-your-application/configuring/environment-variables#environment-variable-load-order), the `.env.local` file generated in this step will override many values that you may want to set in the `.env` or `.env.development` files. Any env vars in development that you want to take precedence over what is in `.env.local` will need to go in `.env.local.development`._

### Install dependences

Make sure you have [`pnpm`](https://pnpm.io/) installed.

Then from the root project directory, install all the node dependencies:

```
$ pnpm install
```

### Set up a stable public proxy URL

[ngrok](https://ngrok.com/) is a tool that can proxy requests to and from a localhost server to a URL on the public internet. You can set up a free account and then create one-off URLs with:

```
$ ngrok http 3000
```

Note: with a free account, this URL will change each time you restart the `ngrok` command, so make sure to update it in the relevant places when that happens.

Grab this URL because you'll need it for a couple `.env.development.local` values and for the _GitHub OAuth Setup_.

Set the following URLs in your `.env.development.local`:

```
# for webhooks use ngrok or similar for stable DNS accessible URL
NEXTAUTH_URL="https://some-unique-value.ngrok-free.app/api/auth"
UPLOADTHING_URL="https://some-unique-value.ngrok-free.app"
NEXT_PUBLIC_URL="https://some-unique-value.ngrok-free.app"
```

_Note: `NEXTAUTH_URL` now needs to end in `/api/auth` for NextAuth v5._

### GitHub OAuth Setup

This app uses GitHub as its OAuth provider. For local development, you'll need to create your own GitHub OAuth Application.

You can create one by visiting the [_Register a new OAuth Application_](https://github.com/settings/applications/new) and following these steps:

- 1. Give it an application name, e.g. "Bob's Local Course Builder"
- 2. Set the Homepage URL to the `ngrok` URL you got in the previous section
- 3. Set the Authorization callback URL to match the `NEXTAUTH_URL` set in the previous section
- 4. No need to give a Description or check Enable Device Flow
- 5. Click 'Register Application'

You will now be dropped on your OAuth Application page where you can:

- 1. Copy the Client ID into the `GITHUB_CLIENT_ID` env var
- 2. Generate a Client Secret and copy it into the `GITHUB_CLIENT_SECRET` env var

These can both go in `.env.development.local`.

### Database Setup

This app uses Planetscale as the database provider and Drizzle as the ORM and migrator.

You'll need to set the `DATABASE_URL` in `.env` to a (non-production) Planetscale connection URL.

First, create a new database in Planetscale. Copy the connection string that you get into the `.env` file as `DATABASE_URL` and make sure that it ends with an SSL query parameter formatted as `?ssl={"rejectUnauthorized":true}`.

Then, apply the database schema to that new database with:

```
$ pnpm db:push
```

### Start the Local Dev Server
1. `pnpm dev` to start the app on localhost in watch mode with inngest and partykit

### Create an Admin User

1. Visit the `ngrok` URL in your browser
2. Click 'Sign In' and authenticate with our GitHub account
3. Connect to your database through the SQL console (planetscale), Drizze Studio (see below), or your favorite database client gui.

#### Configuring Drizzle Studio

1. Configure and run Drizzle Studio, which acts as a local interface for your remote database.
    1. If you're using Safari, you'll need to `brew install mkcert` and then `mkcert -install` first. (You will have to install xcode-select tooling if you don't have it, just follow the prompts)
    2. Run `pnpm db:studio`
    3. Navigate to `https://local.drizzle.studio`
2. Via Drizzle Studio (other flows are possible if you'd prefer, but this is the one we're documenting) find your new `user` record and change the `role` to `admin`. Make sure to save/apply the change.
3. When you visit `/tips`, you'll see the form for creating a new Tip.

## API Documentation

AI-Hero exposes several REST APIs for external integrations. All endpoints require proper authentication using OAuth 2.0 device flow.

The machine-readable contract is self-describing and always current:

- **OpenAPI 3.1 document**: [https://www.aihero.dev/api/openapi.json](https://www.aihero.dev/api/openapi.json) — every operation with request/response schemas, required scopes, and token policies
- **Discovery document**: [https://www.aihero.dev/api](https://www.aihero.dev/api) — route families, agent-token capabilities, and next actions in plain JSON

Prefer these over the prose below when they disagree — they're generated from the same code that serves the routes.

### Authentication

The platform implements OAuth 2.0 device flow (RFC 8628) for secure authentication. Here's a working Node.js example using `openid-client`:

```typescript
import * as client from 'openid-client'

const ISSUER = 'https://www.aihero.dev/oauth'

async function registerDevice() {
  try {
    const config = await client.discovery(new URL(ISSUER), 'ai-hero')
    const deviceResponse = await client.initiateDeviceAuthorization(config, {})

    console.log('deviceResponse', deviceResponse)

    const timeout = setTimeout(() => {
      throw new Error('Device authorization timed out')
    }, deviceResponse.expires_in * 1000)

    try {
      const tokenSet = await client.pollDeviceAuthorizationGrant(
        config,
        deviceResponse,
      )
      clearTimeout(timeout)

      if (!tokenSet) {
        console.log('AUTH_REJECTED, no token set')
        return
      }

      const protectedResourceResponse = await client.fetchProtectedResource(
        config,
        tokenSet.access_token,
        new URL(`${ISSUER}/userinfo`),
        'GET',
      )
      const userinfo = await protectedResourceResponse.json()

      console.dir({ tokenSet, userinfo }, { depth: null })
      console.log('AUTH_RESOLVED')
    } catch (error) {
      clearTimeout(timeout)
      throw error
    }
  } catch (error) {
    console.log('error', error)
    console.log('AUTH_REJECTED')
  }
}

await registerDevice()
```

The flow includes:
1. Discovery of OAuth endpoints
2. Device authorization initiation
3. Polling for user approval
4. Token exchange
5. Protected resource access

Available endpoints:

```
POST /oauth/device/code
- Generates device verification codes
- Returns: { user_code, device_code, verification_uri, expires_in }

POST /oauth/token
- Exchanges device code for access token
- Supports device flow grant type
- Returns: { access_token, token_type, expires_in }

GET /oauth/userinfo
- Returns authenticated user information
- Requires valid access token
```

### Content Management

#### Posts API

```
GET /api/posts
- Lists all accessible posts
- Supports pagination and filtering
- Returns: { posts: Post[], totalCount, pageCount }

POST /api/posts
- Creates new post
- Body: { title, content, status, ... }
- Returns: Created Post

GET /api/posts/:id
- Retrieves specific post
- Returns: Post with version history

PUT /api/posts/:id
- Updates existing post
- Body: { title, content, status, ... }
- Returns: Updated Post

DELETE /api/posts/:id
- Deletes post
- Requires appropriate permissions
```

#### Video Resources

```
GET /api/videos/:videoResourceId
- Retrieves video resource metadata
- Returns: { id, title, status, transcription, ... }

PUT /api/videos/:videoResourceId
- Updates video resource metadata
- Body: { title, description, ... }
- Returns: Updated VideoResource

DELETE /api/videos/:videoResourceId
- Deletes video resource
- Cascades through related resources
```

### File Upload System

The platform uses direct-to-S3 uploads for efficient file handling:

```
POST /api/uploads/signed-url
- Generates pre-signed S3 URL for direct upload
- Body: { filename, contentType, ... }
- Returns: { uploadUrl, key }

POST /api/uploads/new
- Initializes new upload
- Body: { filename, size, ... }
- Returns: { id, status, uploadUrl }
```

### Best Practices

1. **Rate Limiting**: Implement appropriate backoff strategies
2. **Error Handling**: All endpoints return standard HTTP status codes
3. **Authentication**: Always include Bearer token in Authorization header
4. **Versioning**: API versions are embedded in the URL path
5. **Content Types**: All requests should use application/json

### Example Integration

```typescript
const AI_HERO_BASE = 'https://ai-hero.example.com'

// Initialize device flow
const deviceCode = await fetch(`${AI_HERO_BASE}/oauth/device/code`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
})

// Exchange for token
const token = await fetch(`${AI_HERO_BASE}/oauth/token`, {
  method: 'POST',
  body: JSON.stringify({ 
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode.device_code 
  })
})

// Make authenticated requests
const posts = await fetch(`${AI_HERO_BASE}/api/posts`, {
  headers: {
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json'
  }
})
```

For detailed integration examples and SDKs, contact the AI-Hero team.
