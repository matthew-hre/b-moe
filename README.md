# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODc5MDI5LCJleHAiOjE3ODA5MjIyMjl9.CSU2iTVku1ypwHxx8CLMKPWk5D6JMr6F7qNvblP2qM8)

B-MOE is a self-hosted autonomous coding agent designed to streamline development workflows by integrating directly with Linear and GitHub. From issue delegation to PR creation and review monitoring, B-MOE acts as a teammate that helps you build faster.

## Quick Overview

B-MOE intercepts Linear issue delegations, plans implementation, carries out the work in isolated environments, and opens pull requests. It even monitors PR review feedback, triages responses, and learns over time to better assist your team.

## Tech Stack

- **Runtime:** Bun
- **DI:** Awilix
- **Job Queue:** BullMQ + Redis
- **Sandbox:** Docker
- **LLM:** OpenRouter
- **Integration:** Linear (Agent SDK) & GitHub

## Getting Started

### Prerequisites

- Bun
- Node/Redis
- Docker
- Linear OAuth App (with `actor=app` permissions)
- GitHub Personal Access Token

### Environment Configuration

Configure the following environment variables (ensure `env.ts` validations pass):

- `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`
- `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY`
- `REDIS_HOST`, `REDIS_PORT`
- `DOCKER_HOST`
- `REPO_BASE_PATH`
- `BOT_GITHUB_USERNAME`

## Roadmap

- [x] Initial architecture design & project structure.
- [x] Integrate Linear Agent sessions.
- [x] PR lifecycle automation (Refinement → Planning → Action).
- [ ] Advanced self-learning from review feedback.
- [ ] Improved triage rules for noise reduction.

For full technical specifications, architecture details, and coding standards, refer to `AGENTS.md`.
