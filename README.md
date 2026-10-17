# Arbiter

Arbiter helps authors turn a problem into reviewed requirements and executable acceptance tests, then runs submitted JavaScript solutions against those tests in a CreateOS sandbox. Authors review and approve the generated draft before it is published. Published problems have dedicated pages, and their board shows the latest progress.

**This is a prototype, not a production escrow or payment service.** Payments are not enabled in the web workflow. The existing Stripe demo and helper can simulate payment and transfer IDs; do not rely on them to hold, protect, or transfer real funds.

## Requirements

- Node.js 20 or newer
- npm
- A Gemini API key to use AI problem drafting
- CreateOS CLI login or API credentials to run sandbox submissions

## Local setup

From the project root:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` and replace the `GEMINI_API_KEY` placeholder with your **newly rotated** Gemini API key. Keep `.env` private; it is ignored by Git. The server loads it with `dotenv` at startup. Optionally set `GEMINI_MODEL`; the default is `gemini-2.5-flash`.

Configure CreateOS using either:

```powershell
createos login
```

or set `CREATEOS_SANDBOX_API_KEY` / `CREATEOS_API_KEY` in your environment. The client can also use `CREATEOS_SANDBOX_BASE_URL` for a non-default API endpoint.

Start Arbiter:

```powershell
npm start
```

Open <http://localhost:3000>. Without `GEMINI_API_KEY`, drafting is disabled with setup guidance. Without usable CreateOS credentials or a sandbox, tasks can still be viewed, but submissions cannot be tested.

## Tests and demo

```powershell
npm test
```

`npm run demo` runs the separate scripted sandbox/Stripe demonstration. Its Stripe helper may fall back to fabricated test IDs and simulated ledger entries. The demo's “escrow” and payout language does **not** indicate that real funds are held or transferred; do not use it for money movement.

## Product workflow

1. On `/create`, describe a problem in a chat-like flow. Gemini drafts the title, problem description, requirements, and `node:test` acceptance suite.
2. Review and edit the draft. The server requires explicit `approved: true` before creating a problem.
3. Browse `/problems` for published problems and their current progress; open `/problems/:id` for the full specification, submission form, and work log.
4. Submit a complete JavaScript ES module. Arbiter runs the approved acceptance suite in CreateOS and reports the actual test results. An approval does not initiate payment.

Problem descriptions, requirements, chat replies, and public work summaries support a restricted Markdown renderer (headings, emphasis, inline and fenced code, lists, and safe links). Raw HTML is displayed as text; arbitrary HTML is not inserted into the page.

The work log records timestamps, submission summaries, implementation assumptions, sandbox/test outcomes, and feedback. It is intended to be a visible, auditable progress record—not a record of private model reasoning or hidden chain-of-thought.

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Sandbox and Gemini configuration status |
| `GET` | `/api/tasks` | List public problem details and progress |
| `GET` | `/api/tasks/:id` | Read a problem's public details |
| `GET` | `/api/tasks/:id/activity` | Retrieve progress events, summaries, assumptions, and test results |
| `POST` | `/api/draft` | Draft or revise requirements and tests with Gemini |
| `POST` | `/api/tasks` | Publish an author-approved problem; requires `approved: true` |
| `POST` | `/api/tasks/:id/submissions` | Run a solution against the problem's acceptance tests |
| `GET` | `/api/dispute` | Get a report based on the latest in-process test review |

Submission bodies accept `code`, optional `developerId`, and optional user-visible `summary` and `assumptions` (up to 2,000 characters each). Do not put secrets or private reasoning in those fields. Problem APIs omit the acceptance-test source; it is executed server-side in the sandbox.

### MCP

The stateless MCP-compatible endpoint is `POST /mcp`. It supports JSON-RPC initialization, `tools/list`, and `tools/call` for:

- `list_problems`
- `get_problem`
- `submit_solution`
- `get_problem_activity`

Submission tools accept optional public `summary` and `assumptions`. `get_problem_activity` returns the same visible work record as the REST activity endpoint; it does not expose private model reasoning.

## Data and architecture

Problems and activity are persisted locally as JSON:

- `data/tasks.json` — author-created problems and their acceptance-test source
- `data/task-activity.json` — published events, submission summaries, assumptions, and test results

The built-in token-bucket challenge is seeded by `src/tasks.js` and is not a payment-backed listing.

| Path | Responsibility |
| --- | --- |
| `src/server.js` | Node HTTP server, SPA fallback, REST routes, and MCP endpoint |
| `src/tasks.js` | Problem validation, seeded task, local JSON storage, and progress timeline |
| `src/arbiter.js` | Gemini `generateContent` integration and validation of generated drafts |
| `src/escrow-agent.js` | CreateOS sandbox execution and test verdicts |
| `src/sandbox-client.js` | CreateOS API client and local credential lookup |
| `src/stripe-escrow.js` | Legacy Stripe demo helper; simulated fallbacks, not production payments |
| `src/demo.js` | Separate scripted sandbox and simulated Stripe demo |
| `public/index.html` | SPA shell, routes, problem board, authoring/review, and API/MCP guide |
| `public/markdown.js` | Restricted, safe Markdown parsing and DOM rendering |
| `src/*.test.js` | Gemini, Markdown, server/API/MCP, persistence, and acceptance-test coverage |

## Security and deployment limitations

- **Protect credentials.** Never commit `.env`, paste API keys into source or chat, or expose Gemini/CreateOS/Stripe secrets to browser code. If a key is exposed, revoke it and use a newly rotated key.
- **Acceptance tests are executable code.** Authors control the tests that run against submissions. Only publish reviewed test suites, keep CreateOS sandbox isolation configured, and do not treat submitted code or test output as trusted.
- **No endpoint authentication.** REST and MCP routes are unauthenticated. Do not expose this server to the public internet without authentication, authorization, rate limits, and appropriate abuse controls.
- **Local files are not durable service storage.** JSON files are unsuitable for reliable multi-instance or serverless persistence. The app is not Vercel-serverless ready: deployment needs a durable database, protected endpoints, and a sandbox execution design compatible with the hosting environment.
- **No production escrow or payment flow.** The web workflow does not fund or pay out tasks. `src/stripe-escrow.js` contains legacy code that can fabricate payment/transfer identifiers after Stripe errors and labels an uncaptured PaymentIntent as an escrow hold. It is not safe to use for real funds. A real pay-first/release-after-approval product would require a reviewed Stripe Connect design, connected-account onboarding and eligibility, correct charge/capture and delayed-transfer handling, verified webhooks and idempotency, refund/dispute/cancellation paths, and legal/payment review. Stripe is not enabled as production escrow here.
