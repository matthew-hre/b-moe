# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODgxNTM5LCJleHAiOjE3ODA5MjQ3Mzl9.-zFuALhQgX_O4KfylfLRtaU4k4xBxXo7KwkLjKVj4vc)

A self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It runs as a **Linear agent (app user)** — installed via OAuth with `actor=app` — so it appears as a teammate that can be delegated issues and @mentioned.

## Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Docker](https://www.docker.com/) (for sandbox containers)
- Redis (provided via `docker-compose.yml`)
- A Linear workspace with admin access (for the OAuth install)
- A GitHub account or GitHub App for the bot (for PR creation)

### Install dependencies

```sh
bun install
```

### Start Redis

```sh
bun run redis:up
```

### Build the sandbox image

```sh
bun run sandbox:build
```

### Configure environment

Copy `.env.example` to `.env` and fill in the required values:

```sh
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `LINEAR_CLIENT_ID` | Linear OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | Linear OAuth app client secret |
| `LINEAR_WEBHOOK_SECRET` | HMAC secret for Linear webhook signature verification |
| `LINEAR_REDIRECT_URI` | OAuth callback URL (defaults to `origin + /oauth/linear/callback`) |
| `GITHUB_TOKEN` | GitHub personal access token (fallback; prefer GitHub App) |
| `GITHUB_APP_ID` | GitHub App ID for bot-owned PR auth |
| `GITHUB_APP_CLIENT_ID` | GitHub App client ID |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App client secret |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM, `\n`-escaped) |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhook verification |
| `BOT_GITHUB_USERNAME` | Bot's GitHub username (for commit attribution) |
| `OPENROUTER_API_KEY` | OpenRouter API key (for LLM calls) |
| `OPENROUTER_MODEL` | Model to use (default: `google/gemini-3.1-flash-lite`) |
| `PI_COMMAND` | Pi CLI command inside sandbox (default: `pi`) |
| `PI_PROVIDER` | Pi model provider (overrides OpenRouter) |
| `PI_MODEL` | Pi model name (overrides OpenRouter) |
| `PI_API_KEY` | Pi API key (overrides OpenRouter) |
| `REDIS_HOST` | Redis hostname (required) |
| `REDIS_PORT` | Redis port (default: `6379`) |
| `DOCKER_HOST` | Docker host (default: `local`) |
| `SANDBOX_IMAGE` | Sandbox Docker image (default: `b-moe/sandbox:latest`) |
| `REPO_BASE_PATH` | Where repos get cloned inside containers |
| `REPOSITORIES_JSON` | JSON map of repository aliases for Linear guidance |
| `PORT` | Server port (default: `3000`) |

### Install the Linear agent

Open `http://localhost:3000/oauth/linear/authorize` in a browser (a workspace admin must complete this). Or generate an invite link:

```sh
bun run linear:invite
```

### Run the server

```sh
bun run dev    # watch mode
bun run start  # production
```

## Development

```sh
bun test          # run tests
bun run lint      # oxlint
bun run format    # oxfmt --write
```

A Nix flake is also available for the dev shell (`nix develop`).

## Roadmap

### Done

- **Project scaffolding** — Bun runtime, TypeScript strict mode, Awilix DI, BullMQ + Redis job queue
- **Run state machine** — full lifecycle: `queued → refining → planning → acting → pr_opened → monitoring → completed`, with `awaiting_input` pause/resume for human-in-the-loop
- **Linear webhook handler** — `AgentSessionEvent` parsing, HMAC signature verification, `created` and `prompted` triggers
- **Linear OAuth install flow** — authorize redirect, code exchange, app user ID fetch, per-workspace token storage in Redis
- **Linear agent activities** — emit `thought`, `action`, `elicitation`, `response`, `error` activities; push PR URL via `agentSessionUpdate`
- **Agent run worker** — refine issue, LLM-generated plan, plan review elicitation, sandbox provisioning, Pi RPC for implementation, git commit/push, GitHub PR creation, PR URL in Linear session
- **Sandbox service** — Docker container lifecycle (create, start, destroy) via dockerode
- **Pi RPC service** — interface with the Pi coding agent inside sandbox containers
- **Planning service** — OpenRouter-backed plan generation from issue context
- **Git service** — commit all changes, push branches, describe HEAD, check for changes
- **GitHub service** — PR creation with GitHub App installation auth support
- **LLM service** — OpenRouter/AI SDK integration for triage and planning
- **Repository service** — resolve repository aliases from `REPOSITORIES_JSON`
- **Run store** — Redis-backed run state persistence
- **Linear install store** — Redis-backed per-workspace OAuth token storage
- **BullMQ queue** — `agent-run` job queue with Redis connection
- **Docker sandbox image** — `b-moe/sandbox:latest` with Bun, Pi, git, and dev tools
- **Test suite** — 127 tests across 16 files covering state machine, services, routes, stores

### Planned

- **GitHub webhook handler** — PR review feedback, merge/close events (route not yet wired)
- **Review worker** — triage → respond → learn loop (`review.worker.ts`)
- **Review triage** — two-pass system: rules pass + LLM pass (`triage.service.ts`)
- **Self-learning** — extract learnings from review patterns, feed into next run's context (`learning.service.ts`, `context.service.ts`)
- **Monitoring/responding loop** — review feedback handling in the `pr_opened → monitoring ⟷ responding` cycle