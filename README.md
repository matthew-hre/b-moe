# B-MOE

B-MOE is a self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It runs as a **Linear agent (app user)**, acting as a teammate that can be delegated issues, @mentioned, and handles the full PR lifecycle including reviews and feedback.

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODgwMTgwLCJleHAiOjE3ODA5MjMzODB9.lLIk1nN-0LQ3D9zkjWJPsB93W4lpyzeUK0dKdFSv5pM)

## Overview
B-MOE is built as a job processing pipeline using BullMQ and Redis. It monitors webhooks from Linear and GitHub to automate the coding workflow.

### Key Features
- **Linear Delegation:** Automatically handles issues assigned to the B-MOE agent.
- **Autonomous Workflow:** Refines requirements, plans implementation, acts (code/tests), and monitors PR reviews.
- **Review Loop:** Automatically triages PR feedback and responds to actionable items.
- **Learning:** Extracts patterns from reviews to improve future performance.

## Getting Started

### Prerequisites
- Node.js/Bun installed
- Redis server
- Docker (for agent sandbox)
- Linear OAuth App (with `actor=app` scope)
- GitHub account

### Environment Configuration
Create a `.env` file with the following variables based on `src/config/env.ts`:

- `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`
- `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`
- `REDIS_HOST`, `REDIS_PORT`
- `DOCKER_HOST`

### Installation
1. Clone the repository.
2. Install dependencies: `bun install`
3. Configure the environment variables in `.env`.
4. Run the redis container: `bun run redis:up`
5. Start the service: `bun run start`

## Roadmap
- [x] Initial setup and architecture.
- [x] Linear webhook integration.
- [x] GitHub PR automation.
- [ ] Improved self-learning capability.
- [ ] Multi-repo support.

