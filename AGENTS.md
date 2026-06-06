# Project: B-MOE

A self-hosted autonomous coding agent that takes Linear issue assignments, implements them, and opens PRs. It monitors its own PRs for review feedback (human + bot), triages reviews, responds to actionable feedback, and extracts learnings over time.

## Architecture

This is a job processing pipeline, not a CRUD app. The API surface is tiny — two webhook endpoints and a status endpoint. The real work happens in BullMQ workers.

### Stack

- **Runtime:** Bun
- **DI:** Awilix
- **Job queue:** BullMQ + Redis
- **Harness:** Pi coding agent (SDK/RPC mode)
- **Sandbox:** Docker containers
- **Model:** OpenRouter
- **Webhooks:** Linear (issue assignment), GitHub (PR reviews, merge/close)

### Project structure

```
src/
  api/
    routes.ts - POST /webhook/linear, POST /webhook/github, GET /runs
  workers/
    agent-run.worker.ts - full create → PR lifecycle
    review.worker.ts - review → triage → respond → learn
  services/
    linear.service.ts - Linear API client
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
    events.ts - webhook event types
    review.ts - triage types
  store/
    redis.ts - run state, learning log, project cache
  config/
    container.ts - Awilix wiring
    env.ts - environment config

```

### Run state machine

```

queued → refining → planning → acting → pr_opened → monitoring ⟷ responding → completed

```

A run starts when a Linear issue is assigned to the bot. It goes through refine (requirements), plan (implementation plan), and act (write code, run tests, iterate). The PR opens, and the agent enters monitoring. When review comments arrive, it triages them, responds to actionable ones, and loops back to monitoring. The run completes when the PR is merged or closed.

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

- LINEAR_API_KEY
- LINEAR_WEBHOOK_SECRET
- GITHUB_TOKEN
- GITHUB_WEBHOOK_SECRET
- OPENROUTER_API_KEY
- REDIS_HOST
- REDIS_PORT
- DOCKER_HOST (default: local)
- REPO_BASE_PATH (where repos get cloned inside containers)
- BOT_GITHUB_USERNAME (the bot's GitHub account, for PR attribution)
- BOT_LINEAR_USER_ID (the bot's Linear user ID, for issue assignment detection)
