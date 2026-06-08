# B-MOE

<img src="https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwOTM2NDE2LCJleHAiOjE3ODA5Nzk2MTZ9.QfB1tONcQBOWmXufTngAnQxfg-psVxA52U299rLPdnM" alt="BMO" width="200" align="right">

A self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It runs as a **Linear agent (app user)** — installed via OAuth with `actor=app` — so it appears as a teammate that can be delegated issues and @mentioned. It monitors its own PRs for review feedback, triages reviews, responds to actionable feedback, and extracts learnings over time.

## Architecture

This is a job processing pipeline, not a CRUD app. The API surface is small — a Linear webhook, a GitHub webhook, the Linear OAuth install endpoints, and a status endpoint. The real work happens in BullMQ workers.

### Stack

| Layer | Technology |
| ----- | ---------- |
| Runtime | [Bun](https://bun.sh) |
| Dependency injection | [Awilix](https://github.com/jeffijoe/awilix) |
| Job queue | [BullMQ](https://bullmq.io) + Redis |
| Coding harness | [Pi](https://github.com/earendil-works/pi-coding-agent) (SDK/RPC mode) |
| Sandbox | Docker containers |
| Model provider | [OpenRouter](https://openrouter.ai) |
| Webhooks | Linear (Agent Session events), GitHub (PR reviews) |

### Run state machine

```
queued → refining → acting → pr_opened → monitoring ⟷ responding → completed
           ╲        ╱
            ▼      ╱   (elicitation: agent asks a human)
        awaiting_input ──▶ (resumes to the phase it paused from)
              ▲
              └── prompted webhook resumes the run
```

A run starts when Linear delegates an issue to the agent (or @mentions it), which creates an Agent Session and fires a webhook. The worker resolves the repository, starts Pi for the implementation loop, and lets Pi research, plan, edit, verify, and summarize in the same working context. After the PR opens, the agent monitors for review comments, triages them, and responds to actionable ones.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.x
- [Docker](https://docs.docker.com/get-docker/) (for sandbox containers)
- Redis (provided via `docker-compose.yml`)
- A [Linear](https://linear.app) workspace with admin access (for the OAuth install)
- A GitHub account or GitHub App for the bot (for PR creation)
- An [OpenRouter](https://openrouter.ai) API key (for LLM calls)

### Install dependencies

```bash
bun install
```

### Configure environment

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Key variables (see `.env.example` for the full list):

| Variable | Description |
| -------- | ----------- |
| `LINEAR_CLIENT_ID` | Linear OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Linear OAuth app client secret |
| `LINEAR_WEBHOOK_SECRET` | Verifies the `linear-signature` HMAC on webhooks |
| `GITHUB_TOKEN` | GitHub personal access token (or use GitHub App vars) |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM calls |
| `REDIS_HOST` | Redis host (required) |
| `BOT_GITHUB_USERNAME` | Bot's GitHub username for commit attribution |

### Start Redis

```bash
bun run redis:up
```

### Build the sandbox image

```bash
bun run sandbox:build
```

### Run the server

```bash
bun run dev    # watch mode
bun run start  # production
```

The server listens on `http://localhost:3000` (override with `PORT`).

### Install the Linear agent

1. Visit `http://localhost:3000/oauth/linear/authorize` — this redirects to Linear's OAuth consent screen.
2. After approval, Linear sends a callback with an authorization code. The server exchanges it for an access token and stores the install in Redis.
3. Configure your Linear workspace's webhook to point at `http://<your-host>/webhook/linear` with the **Agent session events** category enabled.

You can also generate a direct invite link:

```bash
bun run linear:invite
```

## Project structure

```
src/
  api/routes.ts                    — HTTP endpoints (webhooks, OAuth, health)
  config/container.ts              — Awilix DI wiring
  config/env.ts                    — Zod-validated environment config
  models/run.ts                    — Run state machine and types
  models/linear.ts                 — Linear webhook types and parsing
  queue/queue.ts                   — BullMQ queue and job definitions
  services/
    agent-session-trigger.service.ts — Webhook → run trigger handler
    linear.service.ts              — Linear agent client (emit activities, update session)
    linear-oauth.service.ts        — OAuth code exchange, token refresh
    github.service.ts              — GitHub API client (create PR, auth)
    sandbox.service.ts             — Docker container lifecycle
    pi.service.ts                  — Pi RPC interface (act, respondToReviews)
    pi-config.ts                   — Resolve Pi agent config from env
    pi-prompts.ts                  — Build/parse Pi prompts and responses
    git.service.ts                 — Git operations inside sandboxes
    commit-gen.service.ts          — LLM-powered commit plans and PR descriptions
    repository.service.ts          — Resolve repos from prompt context / aliases
    llm.service.ts                 — OpenRouter integration via Vercel AI SDK
    docker-engine.ts               — Low-level Docker API client
  store/
    redis.ts                       — Redis client factory
    run.store.ts                   — Run state persistence in Redis
    linear-install.store.ts        — Linear OAuth token persistence
  workers/
    agent-run.worker.ts            — Full delegation → PR lifecycle
  logger.ts                        — Tagged, colorized console logger
  index.ts                         — Entry point (Bun.serve)
tests/                             — Unit tests
docker/sandbox/Dockerfile          — Sandbox container image
```

## Scripts

| Command | Description |
| ------- | ----------- |
| `bun run dev` | Start in watch mode |
| `bun run start` | Start production server |
| `bun run test` | Run tests |
| `bun run lint` | Lint with oxlint |
| `bun run format` | Format with oxfmt |
| `bun run redis:up` | Start Redis via Docker Compose |
| `bun run redis:down` | Stop Redis |
| `bun run sandbox:build` | Build the sandbox Docker image |
| `bun run linear:invite` | Generate a Linear OAuth invite link |

## Roadmap

### ✅ Done

- **Core architecture** — Bun runtime, Awilix DI, Zod env validation, tagged logger
- **Run state machine** — Full lifecycle (`queued` → `refining` → `acting` → `pr_opened` → `monitoring` → `completed`) with `awaiting_input` pause/resume
- **Linear integration** — OAuth `actor=app` install flow, webhook signature verification, Agent Session event parsing (`created`, `prompted`, `stop`), agent activity emission (thought/action/elicitation/response/error), `agentSessionUpdate` for PR URLs
- **Agent run worker** — End-to-end delegation → PR pipeline: sandbox provisioning, Pi execution, git operations, commit generation, branch push, PR creation
- **Sandbox service** — Docker container lifecycle (create, start, exec, destroy) with workspace preparation and git identity configuration
- **Pi integration** — RPC interface for `act` and `respondToReviews`, config resolution, prompt building, response parsing
- **Git service** — Commit, push, branch management, change detection, all inside sandbox containers
- **GitHub service** — PR creation, PAT and GitHub App authentication
- **Commit generation** — LLM-powered structured commit plans and PR title/description
- **Repository resolution** — Alias mapping from env config, prompt context parsing
- **LLM service** — OpenRouter integration via Vercel AI SDK
- **Redis stores** — Run state, Linear install tokens
- **Test suite** — 30 tests across service, model, and store layers

### 🔲 Planned

- **Review worker** — PR review → triage → respond → learn cycle
- **GitHub webhook endpoint** — Receive PR review feedback and merge/close events
- **Review triage** — Two-pass filtering: rules pass (dismiss style/naming, act on bug/security) + LLM pass (resolve deferred items)
- **Self-learning** — Extract learnings from review patterns, persist to Redis learning log
- **Context service** — Incorporate learnings and triage rules into next run's AGENTS.md

## License

Private — all rights reserved.
