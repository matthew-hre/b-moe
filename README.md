# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODc4NjA1LCJleHAiOjE3ODA5MjE4MDV9.5LUUm0MoU3K24Cj7x268ZoG5vyfM00p7z3fqeDoShCM)

B-MOE is a self-hosted autonomous coding agent designed to streamline your development workflow by integrating directly with Linear and GitHub.

## How it works

When a Linear issue is delegated to the B-MOE agent, it automatically:
1.  **Refines** the requirements.
2.  **Plans** the implementation.
3.  **Acts** by writing code and executing tests within an isolated Docker sandbox.
4.  **Opens** a GitHub Pull Request for your review.
5.  **Monitors** PR feedback, triages comments, and responds to actionable items.

## Getting Started

### Prerequisites

*   [Bun](https://bun.sh/)
*   Docker (for sandbox environment)
*   Redis (for state management)
*   Linear workspace (with Agent Session API enabled)
*   GitHub repository

### Configuration

Copy `.env.example` to `.env` and configure the following required variables:

- `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` (OAuth App)
- `LINEAR_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY`
- `REDIS_HOST` / `REDIS_PORT`

Start the service using `bun run`.

## Roadmap

- [x] **Core Pipeline:** BullMQ job processing implementation.
- [x] **Linear Integration:** Agent Session webhook handling and activity reporting.
- [x] **GitHub Integration:** PR creation and review webhook handling.
- [x] **Sandbox:** Docker container lifecycle management.
- [ ] **Advanced Self-Learning:** Further iterations on the context-layer learning log.

For detailed architecture and internal documentation, see `AGENTS.md`.
