# B-MOE

B-MOE is a self-hosted autonomous coding agent designed to streamline development by integrating directly with Linear and GitHub. It acts as an autonomous teammate, delegating tasks, implementing solutions, and managing pull request lifecycles.

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODgwMjA0LCJleHAiOjE3ODA5MjM0MDR9.OQ4HOL46X0TQzaa5y6iqHxWw4d7eDMTOys1mSM-TUS4)

## Features

- **Autonomous Agent**: Operates as a Linear app user to handle issues.
- **End-to-End Workflow**: Pipelines issues from delegation through PR lifecycle and monitoring.
- **Self-Learning**: Extracts learnings from PR reviews to improve future performance.
- **Robust Integration**: Real-time feedback loops via Linear and GitHub webhooks.

## Tech Stack

- **Runtime**: Bun
- **Queueing**: BullMQ + Redis
- **Infrastructure**: Docker for sandboxed execution
- **Integrations**: Linear SDK, Octokit (GitHub)
- **Model**: OpenRouter

## Setup

1. **Environment Variables**: Configure the required environment variables in a `.env` file (see `src/config/env.ts` for details).
2. **Installation**: Ensure `bun` is installed, then run `bun install`.
3. **Running**: Use the defined scripts to start the worker and API services.

## Roadmap

- [x] Initial architecture definition
- [x] Linear OAuth and agent session integration
- [x] GitHub PR management
- [x] Basic triage and learning loop
- [ ] Enhancements for complex human-in-the-loop workflows

---

For detailed architectural and design specifications, refer to `AGENTS.md`.
