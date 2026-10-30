# TailVaR Policy Desk

## Project overview and implemented features

A browser application for insurance administrators and customers. Administrators create policies for either demo customer and approve or reject submitted claims. Customers see only their own coverage and claim history, submit claims, and retrieve updated decisions.

Implemented: cookie-based login/logout, server-side role and ownership checks, persistent policies and claims, calendar-date validation, integer monetary accounting, immediate reservation for submitted claims, concurrency-safe decisions, duplicate-submission protection, responsive dashboards, and database constraints.

### Run locally

Requirements: Node.js 22.16+ and npm. Python 3 is optional for the independent SQLite checks.

```powershell
npm install
npm run build
npm run db:migrate
npm run dev
```

Open http://127.0.0.1:5173. Vite serves the frontend and proxies `/api` to Wrangler on port 8787. For same-origin browser requests, the development proxy translates the Origin header to the backend origin; foreign origins are preserved so the API rejects them. Production serves frontend and API on the same origin and does not use this proxy. The build creates the static assets required by Wrangler. Local D1 data persists under `.wrangler/`; migrations do not reset existing data. Restarting the development servers preserves policies and claims.

| Role          | Username  | Password         |
| ------------- | --------- | ---------------- |
| Customer 1    | customer1 | Customer1@Demo26 |
| Customer 2    | customer2 | Customer2@Demo26 |
| Administrator | admin     | Admin@Demo26     |

These are intentionally public fictional demo credentials. The migration stores salted PBKDF2-SHA256 hashes, not plaintext passwords. There is no self-registration.

## Technology stack and rationale

- TypeScript with strict checking across API, shared validation, and frontend.
- React and Vite for client-side forms, policy cards, and claim tables.
- Hono on Cloudflare Workers for a compact same-origin API.
- Cloudflare D1, backed by SQLite, for durable relational data and atomic conditional SQL writes.
- Zod for request validation; SQL constraints and triggers protect accounting independently.
- Vitest/Miniflare for API integration tests; Playwright for browser workflows.

The application intentionally uses a single deployment and no queue, object storage, external identity provider, or notification service. Dependencies are locked in `package-lock.json`; commit that file and use `npm ci` for subsequent installations. Wrangler and Workers types are pinned to compatible versions.

## System architecture

```text
Browser (React)
    | same-origin HTTPS, HttpOnly session cookie
Cloudflare Worker (Hono API + static assets)
    | authenticate -> authorize -> validate -> atomic SQL
Cloudflare D1 (users, sessions, login_attempts, policies, claims)
```

Frontend assets and the API are deployed together to one Worker. The database is a separate D1 resource bound as `DB`; it is not exposed to the browser. There are no browser infrastructure credentials.

`server/index.ts` contains authentication, API routing, authorization, and SQL operations. `shared/domain.ts` defines validation and public DTOs. `src/` contains the application UI. `migrations/` defines the schema, integrity triggers, and demo accounts.

### Accounting and concurrency

`remaining = sum insured - SUM(amount WHERE status IN ('Submitted', 'Approved'))`.

Claim submission is one conditional `INSERT ... SELECT` that checks ownership, dates, remaining capacity, and request uniqueness. The capacity check and insert cannot be interleaved with another write. A database trigger independently prevents over-reservation. Approval/rejection is one conditional update requiring `status='Submitted'`; only one concurrent decision succeeds. Remaining capacity is derived rather than stored, so rejection releases capacity without a second balance update.

A client-generated UUID identifies each claim submission. Repeating an identical request returns the existing claim; reusing the UUID for another payload produces HTTP 409. The browser preserves this UUID on network failure until the form is edited or submission succeeds.

### Authentication and errors

Sessions expire after eight hours and are stored as SHA-256 token hashes. HTTPS cookies are Secure, HttpOnly, SameSite=Strict; localhost HTTP omits Secure. Logout deletes the session. User identity and role come only from the session. Customers' queries are filtered by policy ownership. Wrong-owner submissions return 404. Mutations require JSON and reject cross-origin browser requests.

Login attempts are limited to 20 per five-minute window per IP/username pair. This is basic demo protection, not a distributed abuse-prevention system. Password hashing uses Workers-compatible Web Crypto PBKDF2-SHA256 with 100,000 iterations and distinct demo salts; this choice must be reassessed for production identities. Validate deployed login latency and free-tier CPU limits before submission.

Validation failures return 400, missing sessions 401, role violations 403, unavailable owned policies 404, and capacity/decision conflicts 409. API responses are not cached. No read replicas are required; leave D1 read replication disabled to keep retrieval straightforward.

### Cloud deployment

The database ID in `wrangler.jsonc` is a placeholder. Deployment has not been performed yet.

```powershell
npx wrangler login
npx wrangler d1 create tailvar
```

Copy the returned database ID into `wrangler.jsonc`. Then:

```powershell
npx wrangler d1 migrations apply tailvar --remote
npm run deploy
```

Verify all three logins and the complete create/submit/decide workflow on the resulting HTTPS URL. Restart/redeploy and verify existing data survives. Keep the same database binding across deployments. Never delete/recreate the remote database as a deployment step.

Cloudflare free allowances are suitable for expected demo use, but quota exhaustion can interrupt service. Monitor Worker/D1 usage and errors, and retain the deployment through **30 November 2026, 11:59 PM IST**. No scheduled monitoring has been configured.

## Live application URL

**Pending deployment. Replace this line with the verified public HTTPS URL before submission.**

## Tests performed

```powershell
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run format:check
python scripts/check_database.py
```

The browser suite requires the local migration and initial build above. It creates fictional records in the local database and uses separate browser sessions for the three accounts.

Current execution status:

- **Passed:** eight independent SQLite checks against the shipped migration and the exact atomic insert/update statements extracted from the API. Includes concurrent reservations, conflicting decisions, duplicate delivery, ownership/date filtering, accounting transitions, constraints, seeded password hashes, and persistence across connections.
- **Passed:** `npm run typecheck` for the complete project and `npm run format:check`, using the installed, locked project dependencies.
- **Passed in the owner's terminal:** the production Vite build completed successfully after the frontend cleanup (29 modules; JavaScript 235.19 kB / 72.98 kB gzip), without the earlier Zod warnings. The local D1 migration also completed successfully (15 commands).
- **Passed in the owner's terminal:** `npm test` completed with all 16 tests passing (30 October 2026): 13 API tests in Miniflare's Cloudflare Workers runtime and three development-proxy tests. Coverage includes validation, authentication, customer isolation, session expiry/logout, cross-origin rejection, coverage boundaries, reservation/release accounting, concurrent submissions and decisions, retry deduplication, database integrity, and safe development-origin translation. Miniflare is locked to the exact v5 version used by Wrangler.
- **Passed in the owner's terminal:** `npm run test:e2e` completed with one Playwright workflow passing (4.8 seconds for the test; 18.6 seconds total). The browser verified administrator login and policy creation, customer login and claim submission, administrator rejection, the customer's refreshed rejection status and restored balance, isolation from the second customer, and logout.
- **Pending:** real Cloudflare deployment, production login CPU/latency checks, production workflow verification, and persistence across deployment.

The coding sandbox blocks child-process pipes required by Vite, Miniflare, and Playwright. The owner executed the standard build, migration, API, and browser commands in a local terminal and supplied their successful output. Local verification does not replace the pending production deployment checks.

## Edge cases identified, their handling, and fixes made

| Case                                                   | Handling                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| Two claims compete for the same remaining SI           | Atomic conditional insert; second request fails if capacity is insufficient |
| Approval races rejection                               | Conditional update permits exactly one decision                             |
| Network retry duplicates a claim                       | Unique request ID; identical retries return the original claim              |
| Decided claim is decided again                         | HTTP 409; trigger also rejects invalid transition                           |
| Wrong customer's policy ID                             | Server ownership filter; no claim created                                   |
| Exact remaining SI                                     | Accepted; balance becomes zero                                              |
| Incident on either boundary                            | Accepted; dates are inclusive                                               |
| Invalid calendar date or end before start              | Server validation rejects it                                                |
| Fractional cents, non-positive money, unsafe magnitude | Strict decimal-string parsing and integer storage limits                    |
| Rejecting a reserved claim                             | Rejected amount no longer contributes to used SI                            |
| Refresh after another user's decision                  | Database is retrieved again; no cached API responses                        |
| Expired/revoked session                                | HTTP 401; browser returns to sign-in                                        |

During implementation, the SQL test harness was changed to use workspace-local temporary database files because the execution sandbox could not access Python-created system temporary directories. SQL test connections are closed explicitly so Windows can remove the temporary files.

The API suite's migration loader initially split triggers at `CASE ... END;` expressions. It now recognizes the standalone trigger terminator, and the complete API suite passes with the local SQLite adapter. Dependency installation also exposed an incompatible Workers types range; Wrangler and Workers types were aligned and installation completed successfully. The direct Miniflare dependency was subsequently aligned with Wrangler's runtime version after the first native test run exposed its older compatibility-date limit.

The first browser test identified a development proxy origin mismatch between ports 5173 and 8787. The fix translates same-origin frontend requests in Vite's proxy only; production authorization and cross-origin checks remain enforced by the API. Regression coverage includes foreign origins, mismatched ports/schemes, and missing headers.

The subsequent browser trace confirmed successful authentication and dashboard data retrieval but exposed a test selector issue: exact label text included nested select-option text. The tests now select the Customer and Policy dropdowns by accessible combobox role/name, matching the page's accessibility snapshot.

## Assumptions, design trade-offs, known limitations and outstanding issues

- Currency is INR with two decimal places. Amounts are bounded to ₹9,999,999,999.99. Coverage/incident years are 1900–9999.
- Same-day policies are valid. Claim eligibility depends on incident date, not submission date. There is no additional prohibition on future incident dates within coverage.
- Policies and claim financial fields are immutable. No deletion, registration, password reset, attachments, appeals, or notifications are implemented.
- An administrator cannot submit claims. Only the two Customer accounts can own policies.
- UI lists are unpaginated for this small demo. Pagination and broader abuse protection would be needed at production scale.
- New deployments start with the three accounts and no policies. Administrators create the initial coverage; migrations preserve subsequent data.
- There is no contractual uptime guarantee on the free plan. Operational availability through the assignment deadline must be checked by the owner.
- Production deployment and its verification, the live URL, and the full AI conversation export remain outstanding as described above.

## AI tools used, how they were used, and location of submitted AI conversation logs

OpenAI Codex assisted with reading the assignment, architecture design, code generation, SQL concurrency checks, test authoring, and documentation. The owner must review the generated implementation and the remaining validation results.

`ai-logs/README.txt` records the export instructions and current status. **A complete transcript export has not yet been supplied.** Export the actual assignment-related conversations into `ai-logs/` before packaging; redact infrastructure secrets and unrelated personal information. This README is not a replacement for the required conversation logs.

## Submission preparation

Submit by **7 November 2026, 11:59 PM IST**. Include the live URL in this README and the email body. Keep the repository private because the assignment is confidential.

The ZIP should contain source, migrations, configuration, lockfile, README, and redacted AI logs. Exclude `node_modules`, `dist`, `.wrangler`, `.npm-cache`, `.verification`, browser reports, local environment files, the confidential source PDF, and infrastructure credentials. Public fictional demo credentials may remain in the README. Email submission is a separate action and has not been performed.
