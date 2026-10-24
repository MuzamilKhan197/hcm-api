# HCM Lite Backend

Express 5 API for HCM Lite. The app uses MongoDB Atlas, JWT sessions in secure HttpOnly cookies, and server-checked roles. Demo storage is for local development only and is not included in the Vercel entry point.

## Requirements

- Node.js 22.12 or later
- MongoDB Atlas (or a local replica set for development)
- A random `JWT_SECRET` containing at least 32 characters
- The exact HTTPS origin of the deployed frontend as `CLIENT_URL`

## Local development

From this directory, install dependencies and copy `.env.example` to `.env`. Set `MONGODB_URI`, `JWT_SECRET`, and `CLIENT_URL`, then run:

```sh
npm install
npm run dev
```

For the explicit, local-only sample workspace:

```sh
npm run dev:demo
```

The demo uses `data/demo.json`; it must not be used for production. The app's local server is `server.js`; production uses the app export in `app.js` and does not call `listen()`.

## Vercel deployment

The existing backend is `https://hcm-api.vercel.app`, connected to `MuzamilKhan197/hcm-api`. Use the repository root as Vercel's Root Directory, the Express framework preset, and Node.js 22 or later. Leave Build Command and Output Directory at their Express defaults; do not run `server.js` or select `src` as the project root.

The root `app.js` directly imports Express and default-exports the application. It is the single function configured in `vercel.json`. `src/app.js` is only a compatibility re-export, and `src/create-app.js` is the testable application factory. `server.js` is for local development. The entry point always exports a function, including when environment configuration is missing. In that case API requests receive an actionable JSON 503 instead of `FUNCTION_INVOCATION_FAILED`. MongoDB initialization is cached across warm and concurrent requests; a failed initialization is retried.

Set these **Production** environment variables in Vercel (and Preview only when you have a corresponding trusted frontend origin):

| Name | Value |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string for the production database |
| `JWT_SECRET` | Unique cryptographically random secret, at least 32 characters |
| `CLIENT_URL` | `https://hcm-client-seven.vercel.app` |
| `NODE_ENV` | Vercel sets `production` automatically for Production deployments; the app also checks `VERCEL_ENV` |
| `OPENAI_API_KEY` | Optional; keep the key only in the backend project |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4o-mini` |

Add these values in the backend Vercel project's **Production** environment and redeploy. Do not set `NODE_ENV` globally to `production` for Preview or Development deployments. Set `CLIENT_URL` to the frontend deployment's exact origin (no trailing path); update it if the frontend's production domain changes.

In Atlas, add the Vercel deployment's outbound access as appropriate for your Atlas network policy. Prefer a private connection or a narrowly scoped network policy over allowing all IP addresses. Create a dedicated least-privilege database user. Do not put credentials in this repository or in frontend variables.

After deployment, verify `https://<backend-domain>/api/health` returns `{"ok":true,"storage":"mongodb"}`. This endpoint pings MongoDB. Complete first-run company setup at the frontend URL; there are no default production users.

The frontend's Vercel rewrite forwards `/api/:path*` to `https://hcm-api.vercel.app/api/:path*`. Browser requests and host-only cookies therefore stay on the frontend origin, avoiding third-party cookie restrictions. Existing production cookies remain `SameSite=None; Secure; HttpOnly`, and unsafe requests still require the exact trusted `CLIENT_URL` origin. Do not use wildcard origins or disable origin validation.

## Fixing the reported deployment error

Push these backend changes, then redeploy the **latest commit** in Vercel (disable “Use existing Build Cache” for the first corrective deployment). Redeploying an old deployment can reuse the same broken source. Verify:

- `https://hcm-api.vercel.app/` returns the API service description. This is liveness only.
- `https://hcm-api.vercel.app/api/health` returns HTTP 200 after a real MongoDB ping.
- `https://hcm-api.vercel.app/api/auth/status` and `/auth/status` both return JSON.
- Missing configuration produces `SERVER_CONFIGURATION_ERROR`; a database connection failure produces `DATABASE_UNAVAILABLE`. Set the indicated backend variables and redeploy; never place secrets in the frontend.

The frontend must also deploy its latest commit to install the `/api` proxy and discard its previously built root-only API URL. See its README for exact settings.

The built-in request limiters (including the assistant's 20 requests per minute) use in-memory counters, so limits are per serverless instance rather than global across Vercel. Treat them as a basic safeguard, not distributed abuse protection; add a shared rate-limit store or Vercel Firewall rules before handling significant public traffic.

The assistant remains local-only when `OPENAI_API_KEY` is unset. When configured, it sends the question and a minimal role-scoped summary (aggregate counts and, for employees, leave balances) to OpenAI; it does not send employee names, emails, salaries, or raw records. AI provider failures return an explicit API error rather than silently switching to local answers.

## Tests

```sh
npm test
```

Tests use the isolated demo repository and do not require Atlas credentials.

## API overview

API routes are prefixed with `/api`. For compatibility, the authentication routes are also available directly under `/auth` (including the reported `GET /auth/status`); both prefixes use the same CORS, request-origin, and rate-limit protections. Mutating and protected routes use an HttpOnly session cookie; public account setup is available only before a company exists.

| Route | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | API and MongoDB readiness |
| `GET /auth/status` | Public | Setup state and assistant mode |
| `POST /auth/setup` | Public, one-time | Create company and first admin |
| `POST /auth/login`, `POST /auth/logout` | Public / session | Sign in and clear session |
| `GET /auth/me`, `PATCH /auth/profile`, `PATCH /auth/password` | Signed in | Session, profile, and password |
| `GET /workspace` | Signed in | Role-scoped workspace snapshot |
| `/employees`, `/departments`, `/attendance`, `/leaves`, `/payrolls` | Role-dependent | People and HR workflows |
| `DELETE /employees/:id` | Admin | Permanently deletes the employee account/profile and linked records; irreversible |
| `/announcements`, `/notifications`, `/company`, `/holidays` | Role-dependent | Company tools and settings |
| `POST /assistant` | Signed in, rate-limited | Local or configured provider answer |

The complete accepted request shapes and authorization rules are enforced in the route validators and role middleware in `src/controllers/auth.js`, `src/routes/workspace.js`, and `src/middleware/auth.js`. This release is a **single-company deployment**: it uses one company singleton and does not provide multi-tenant company IDs or cross-company partitioning. Use separate deployments and databases per company until multi-tenancy is designed and tested.

There is no email delivery provider configured, so password-reset delivery is not implemented. Account recovery currently requires an administrator-managed process; do not add a public token-issuing reset endpoint without a trusted delivery channel and expiring, single-use token storage.

New passwords must be 8–72 characters during initial setup, employee account creation, and password changes. Login continues to accept existing credentials without a new-password minimum check.
