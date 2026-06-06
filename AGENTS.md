# Project: B-MOE

A self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It runs as a **Linear agent (app user)** — installed via OAuth with `actor=app` — so it appears as a teammate that can be delegated issues and @mentioned. It monitors its own PRs for review feedback (human + bot), triages reviews, responds to actionable feedback, and extracts learnings over time.

> Linear's Agents APIs are a Developer Preview as of June 2026; payload shapes and mutations may change before GA. This is the sanctioned path and supersedes the older `actor=application` / bot-on-a-regular-account approach.

## Architecture

This is a job processing pipeline, not a CRUD app. The API surface is tiny — a Linear webhook, a GitHub webhook, the Linear OAuth install endpoints, and a status endpoint. The real work happens in BullMQ workers.

### Stack

- **Runtime:** Bun
- **DI:** Awilix
- **Job queue:** BullMQ + Redis
- **Harness:** Pi coding agent (SDK/RPC mode)
- **Sandbox:** Docker containers
- **Model:** OpenRouter
- **Webhooks:** Linear (`AgentSessionEvent`: created/prompted), GitHub (PR reviews, merge/close)

### Project structure

```
src/
  api/
    routes.ts - POST /webhook/linear, POST /webhook/github, GET /runs,
                GET /oauth/linear/authorize, GET /oauth/linear/callback
  workers/
    agent-run.worker.ts - full delegation → PR lifecycle
    review.worker.ts - review → triage → respond → learn
  services/
    linear.service.ts - Linear agent client: emit agent activities
                        (thought/action/elicitation/response/error),
                        agentSessionUpdate (externalUrls / PR link)
    linear-oauth.service.ts - actor=app install, exchange code, fetch app user id
    github.service.ts - GitHub API client
    sandbox.service.ts - Docker container lifecycle
    pi.service.ts - Pi RPC interface (refine, plan, act, respondToReviews)
    context.service.ts - builds AGENTS.md from project graph + learnings + triage rules
    learning.service.ts - extract learnings from review patterns
    triage.service.ts - rules + LLM pass for review filtering
  queue/
    queue.ts - BullMQ queues, job definitions
  models/
    run.ts - state machine, types
    linear.ts - AgentSessionEvent webhook types, prompt context parsing
    events.ts - webhook event types
    review.ts - triage types
  store/
    redis.ts - run state, learning log, project cache,
               Linear install tokens (access token + per-workspace app user id)
  config/
    container.ts - Awilix wiring
    env.ts - environment config

```

### Run state machine

```

queued → refining → planning → acting → pr_opened → monitoring ⟷ responding → completed
                 ╲       │        ╱
                  ╲      ▼       ╱   (elicitation: agent asks a human)
                   ──▶ awaiting_input ──▶ (resumes to the phase it paused from)
                              ▲
                              └── prompted webhook resumes the run

```

A run starts when Linear delegates an issue to the agent (or @mentions it), which creates an **Agent Session** and fires an `AgentSessionEvent` (`action: "created"`) webhook. The webhook handler must ack within 5s, enqueue the run, and emit a `thought` activity within 10s or the session is marked unresponsive. The run goes through refine (requirements), plan (implementation plan), and act (write code, run tests, iterate). The PR opens, and the agent enters monitoring. When review comments arrive, it triages them, responds to actionable ones, and loops back to monitoring. The run completes when the PR is merged or closed.

**Human-in-the-loop (`awaiting_input`).** At any point during `refining`/`planning`/`acting`, the agent can pause for human input — typically by posting a plan and emitting an `elicitation` activity ("approve this plan?"), then transitioning to `awaiting_input`. The run stores which phase it paused from. A subsequent `prompted` webhook (the human's reply) resumes the run back into that phase with the reply injected into context. We design the state for this now; we don't have to wire an elicitation at every phase on day one.

There are two human-facing feedback channels:

- **GitHub webhook** → PR review feedback (the `monitoring ⟷ responding` loop).
- **Linear `AgentSessionEvent` (`action: "prompted"`)** → a human replied into the session (`agentActivity.body`). It resumes the active run (from `awaiting_input`, or as added context if the run is still moving) rather than starting a new one.

### Linear integration (Agent Session model)

- **Install:** OAuth `actor=app` with scopes `read write app:assignable app:mentionable`. `actor=app` cannot also request `admin`. Install requires a workspace admin. Enable the **Agent session events** webhook category in the OAuth app config.
- **Identity:** after install, fetch and store the per-workspace app user id (`viewer { id }`) alongside the access token. Delegating an issue to the app sets it as the issue's `delegate`, not `assignee` — so do not detect work via Issue assignee webhooks.
- **Inbound:** parse `AgentSessionEvent` webhooks (payload under `agentSession`, not `data`). Verify the `linear-signature` HMAC over the raw request body using `LINEAR_WEBHOOK_SECRET`. Build the harness prompt from the `promptContext` string (issue + comments + workspace/team `guidance`, e.g. preferred repos).
- **Outbound:** report progress by emitting Agent Activities (`thought`, `action`, `elicitation`, `response`, `error`); Linear manages session state (working/waiting/done/error) automatically — we do not. Surface the PR by pushing its URL into the session's `externalUrls` via the `agentSessionUpdate` mutation.

### Review triage (two-pass)

1. **Rules pass** — dismiss CodeRabbit style/naming/refactor, act on bug/security/error-handling, defer ambiguous
2. **LLM pass** — quick call on deferred items with comment + code context

### Self-learning (context-layer)

- Extract what went wrong from PR review feedback
- Write learnings to a learning log in Redis
- context.service incorporates learnings into the next run's AGENTS.md
- Triage rules are also mutable — the agent learns which review categories matter to the team

## Code style

- TypeScript, strict mode
- Prefer composition over inheritance
- Services are classes with async methods, injected via Awilix
- Workers are plain async functions that receive services from the container
- Models are type definitions and pure functions (state transitions, etc.)
- No ORM. Redis access through thin helpers in store/.
- Descriptive variable names, no abbreviations except well-known ones (PR, LLM, RPC)
- Error handling: throw specific errors, catch at the worker boundary, log and retry based on job config
- Comments only when the code can't explain itself (which should be never, preferably)

## Testing

- Write tests for services (mock external APIs)
- Write tests for the state machine transitions
- Write tests for triage logic
- Workers are harder to test end-to-end — focus on service-level tests

## Dependencies

- bun
- awilix
- bullmq
- ioredis
- dockerode (Docker API client)
- @linear/sdk (Linear API client)
- octokit (GitHub API client)
- open (for Pi RPC — we'll figure this out as we go, Pi uses JSON over stdin/stdout)

## Environment variables (define in .env, validate in env.ts)

- LINEAR_CLIENT_ID (OAuth app client id, for the actor=app install)
- LINEAR_CLIENT_SECRET (OAuth app client secret)
- LINEAR_REDIRECT_URI (OAuth callback URL; defaults to the request origin + callback path)
- LINEAR_WEBHOOK_SECRET (verifies the linear-signature HMAC on incoming webhooks)
- GITHUB_TOKEN
- GITHUB_WEBHOOK_SECRET
- OPENROUTER_API_KEY
- REDIS_HOST
- REDIS_PORT
- DOCKER_HOST (default: local)
- REPO_BASE_PATH (where repos get cloned inside containers)
- BOT_GITHUB_USERNAME (the bot's GitHub account, for PR attribution)
