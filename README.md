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

Import the `hcm-lite-backend` GitHub repository as a new Vercel project named `hcm-lite-api` and keep the project root at the repository root. Vercel detects the Express app export in `app.js` and runs it as a Node.js Function. The included `vercel.json` sets the function timeout.

Set these **Production** environment variables in Vercel (and Preview only when you have a corresponding trusted frontend origin):

| Name | Value |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string for the production database |
| `JWT_SECRET` | Unique cryptographically random secret, at least 32 characters |
| `CLIENT_URL` | Exact HTTPS origin of the frontend, with no path |
| `NODE_ENV` | `production` |
| `OPENAI_API_KEY` | Optional; keep the key only in the backend project |
| `OPENAI_MODEL` | Optional; defaults to `gpt-4o-mini` |

In Atlas, add the Vercel deployment's outbound access as appropriate for your Atlas network policy. Prefer a private connection or a narrowly scoped network policy over allowing all IP addresses. Create a dedicated least-privilege database user. Do not put credentials in this repository or in frontend variables.

After deployment, verify `https://<backend-domain>/api/health` returns `{"ok":true,"storage":"mongodb"}`. This endpoint pings MongoDB. Complete first-run company setup at the frontend URL; there are no default production users.

Production session cookies use `SameSite=None; Secure` for credentialed requests from the separate frontend origin. The backend accepts unsafe requests only from the exact `CLIENT_URL` origin (and requires an Origin header in production). Browser privacy settings may still block third-party cookies on default `*.vercel.app` domains. For reliable sign-in, attach frontend and API custom domains under the same registrable domain (for example, `app.example.com` and `api.example.com`).

The built-in request limiters (including the assistant's 20 requests per minute) use in-memory counters, so limits are per serverless instance rather than global across Vercel. Treat them as a basic safeguard, not distributed abuse protection; add a shared rate-limit store or Vercel Firewall rules before handling significant public traffic.

The assistant remains local-only when `OPENAI_API_KEY` is unset. When configured, it sends the question and a minimal role-scoped summary (aggregate counts and, for employees, leave balances) to OpenAI; it does not send employee names, emails, salaries, or raw records. AI provider failures return an explicit API error rather than silently switching to local answers.

## Tests

```sh
npm test
```

Tests use the isolated demo repository and do not require Atlas credentials.

## API overview

All routes are prefixed with `/api`. Mutating and protected routes use an HttpOnly session cookie; public account setup is available only before a company exists.

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
