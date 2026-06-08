# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODc3NjYwLCJleHAiOjE3ODA5MjA4NjB9.H7udibud7XYr1glNE6pUNRLkOPsghTVe7lo6ueUbqSI)

B-MOE is a self-hosted autonomous coding agent that takes Linear issue delegations, implements them, and opens PRs. It acts as a teammate that can be delegated tasks, providing a structured approach to automated development.

## Installation & Setup

1. **Prerequisites:**
   - [Bun](https://bun.sh/)
   - Redis
   - Docker (for sandbox execution)

2. **Environment Configuration:**
   Copy the `.env.example` file to `.env` and fill in the required variables (Linear, GitHub, OpenRouter keys, etc.).

3. **Development:**
   - Install dependencies: `bun install`
   - Start the service: `bun run dev`

## Roadmap

- [x] Initial agent architecture design
- [x] Linear webhook integration (Agent Session events)
- [x] GitHub webhook integration (PR reviews)
- [x] BullMQ job processing pipeline
- [x] Docker sandbox implementation
- [ ] Self-learning mechanism improvements
- [ ] Improved triage accuracy
