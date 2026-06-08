# B-MOE

<img src="https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzg4MDk1MTY0NywiZXhwIjoxNzgwOTk0ODQ3fQ.F4AQarcn-p4sMBeaMow80Z1iTveXZkPGR1a6ZIQuL3c" alt="BMO" width="200" align="right" />

A self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. B-MOE runs as a **Linear agent (app user)** — installed via OAuth with `actor=app` — so it appears as a teammate that can be delegated issues and @mentioned.

> Linear's Agents APIs are a Developer Preview as of June 2026; payload shapes and mutations may change before GA.

## Note: Zig Backend

B-MOE uses a **Zig-based sandbox backend** for container orchestration and execution. The sandbox Docker image (defined in `docker/sandbox/Dockerfile`) provisions isolated environments where Pi runs against the target repository, providing safe, reproducible execution isolation for every agent run.

## Stack

- **Runtime:** Bun
- **DI:** Awilix
- **Job queue:** BullMQ + Redis
- **Harness:** Pi coding agent (SDK/RPC mode)
- **Sandbox:** Docker containers (Zig backend)
- **Model:** OpenRouter (default: `google/gemini-3.1-flash-lite`)
- **Webhooks:** Linear (`AgentSessionEvent`), GitHub (PR reviews, merge/close)

## Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime
- Redis (via `docker compose up -d redis`)
- Docker (for sandbox containers)

### Install

```bash
bun install
```

### Environment variables

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Key variables (validated in `src/config/env.ts`):

| Variable | Required | Description |
|---|---|---|
| `REDIS_HOST` | **Yes** | Redis host |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `LINEAR_CLIENT_ID` | No* | Linear OAuth app client ID |
| `LINEAR_CLIENT_SECRET` | No* | Linear OAuth app client secret |
| `LINEAR_REDIRECT_URI` | No | OAuth callback URL |
| `LINEAR_WEBHOOK_SECRET` | No* | Verifies Linear webhook HMAC |
| `GITHUB_TOKEN` | No* | GitHub token for PR creation |
| `GITHUB_WEBHOOK_SECRET` | No* | Verifies GitHub webhook HMAC |
| `OPENROUTER_API_KEY` | No* | OpenRouter API key for LLM |
| `OPENROUTER_MODEL` | No | Model to use (default: `google/gemini-3.1-flash-lite`) |
| `PI_COMMAND` | No | Pi CLI command (default: `pi`) |
| `BOT_GITHUB_USERNAME` | No | Bot's GitHub username for commit attribution |
| `SANDBOX_IMAGE` | No | Sandbox Docker image (default: `b-moe/sandbox:latest`) |
| `REPOSITORIES_JSON` | No | Repository alias config for Linear guidance |
_\* Required for the corresponding feature to work (Linear integration, GitHub integration, LLM calls), but not enforced at startup._

### Build the sandbox image

```bash
bun run sandbox:build
# or: docker build -t b-moe/sandbox:latest docker/sandbox
```

### Start Redis

```bash
bun run redis:up
```

### Run

```bash
bun run dev    # watch mode
bun run start  # production
```

### Generate Linear OAuth invite link

```bash
bun run linear:invite
```

## Architecture

B-MOE is a job processing pipeline — the API surface is small (webhooks + OAuth + status), and the real work happens in BullMQ workers.

```
src/
  api/routes.ts          – Webhook endpoints, OAuth, health check
  config/container.ts    – Awilix DI wiring
  config/env.ts          – Zod-validated environment config
  workers/               – BullMQ workers (agent run)
  services/              – Linear, GitHub, Pi, sandbox, git, LLM, commit-gen
  models/run.ts          – State machine & types
  models/linear.ts       – AgentSessionEvent webhook types
  store/                 – Redis-backed state (runs, learnings, install tokens)
  queue/queue.ts         – BullMQ queue definitions
```

### Run state machine

```
queued → refining → acting → pr_opened → monitoring ⟷ responding → completed
           ╲        ╱
            ▼      ╱   (elicitation: agent asks a human)
        awaiting_input ──▶ (resumes to the phase it paused from)
```

## Roadmap

### Done

- ✅ Project scaffolding, DI container, and environment validation (`src/config/`)
- ✅ Run state machine with all transitions (`src/models/run.ts`)
- ✅ Linear webhook parsing and HMAC verification (`src/api/routes.ts`)
- ✅ Linear Agent Session integration — OAuth install, activity emission, session updates (`src/services/linear.service.ts`, `src/services/linear-oauth.service.ts`)
- ✅ GitHub PR creation and webhook handling (`src/services/github.service.ts`)
- ✅ Docker sandbox provisioning and workspace preparation (`src/services/sandbox.service.ts`)
- ✅ Pi RPC integration for acting phase (`src/services/pi.service.ts`)
- ✅ Agent run worker — full delegation → commit → PR lifecycle (`src/workers/agent-run.worker.ts`)
- ✅ Git operations inside sandbox containers (`src/services/git.service.ts`)
- ✅ LLM-powered commit message generation (`src/services/commit-gen.service.ts`)
- ✅ Agent session trigger service for webhook → job dispatch (`src/services/agent-session-trigger.service.ts`)
- ✅ Redis-backed run store with state transitions (`src/store/run.store.ts`, `src/store/redis.ts`)
- ✅ Linear install token storage (`src/store/linear-install.store.ts`)
- ✅ Pi config and prompt construction (`src/services/pi-config.ts`, `src/services/pi-prompts.ts`)
- ✅ Repository resolution and authenticated clone URLs (`src/services/repository.service.ts`)
- ✅ Nix flake dev shell (`flake.nix`, `nix/devShell.nix`)
- ✅ 157 tests passing across 18 test files

### Planned

- 🔲 Review worker — triage PR review feedback, respond, loop back to monitoring
- 🔲 Learning service — extract learnings from review patterns, write to Redis log
- 🔲 Context service — build AGENTS.md from project graph + learnings + triage rules
- 🔲 Triage service — rules + LLM pass for review filtering
- 🔲 GitHub App authentication (currently uses personal access token)
- 🔲 Multi-repository support via `REPOSITORIES_JSON` guidance