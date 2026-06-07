# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODc0NzkxLCJleHAiOjE3ODA5MTc5OTF9.KIhPEMXyOd8xQOaXiug5uI9maPrfsDUBmvKIJTyDAnw)

A self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It runs as a Linear agent (app user) to collaborate directly with your team.

## Installation / Setup

1. **Prerequisites:**
   - [Bun](https://bun.sh/)
   - [Docker](https://www.docker.com/)
   - Redis

2. **Environment Variables:**
   Copy the example environment configuration and fill in the required OAuth credentials and API keys (`LINEAR_CLIENT_ID`, `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, etc.).

3. **Development:**
   ```bash
   bun install
   # Configure environment in .env
   bun dev
   ```

## Roadmap

- [x] Initial core architecture (job queue, services, webhooks)
- [x] Linear OAuth integration
- [ ] Implement core agent run loop (refining → planning → acting)
- [ ] GitHub PR interaction and review triage
- [ ] Self-learning system
