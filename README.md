# B-MOE

![BMO](https://uploads.linear.app/ae036e32-8699-43b0-b3dd-3a51aa9f6980/bf2f90dd-0210-41f6-ba85-19b29a2bc3fb/56df7fae-a611-4138-b667-e7d161cfd853?signature=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwYXRoIjoiL2FlMDM2ZTMyLTg2OTktNDNiMC1iM2RkLTNhNTFhYTlmNjk4MC9iZjJmOTBkZC0wMjEwLTQxZjYtYmE4NS0xOWIyOWEyYmMzZmIvNTZkZjdmYWUtYTYxMS00MTM4LWI2NjctZTdkMTYxY2ZkODUzIiwiaWF0IjoxNzgwODc1MTg0LCJleHAiOjE3ODA5MTgzODR9.nWddPtZWyden1utSNuUAOsTim13TiO6igx9Ct26Yx5c)

B-MOE is a self-hosted autonomous coding agent designed to streamline development by integrating directly with Linear and GitHub. It acts as a dedicated teammate that can handle issue delegations, implement features, and manage the PR lifecycle automatically.

## Installation / Setup

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd b-moe
   ```

2. **Install dependencies:**
   Make sure you have [Bun](https://bun.sh/) installed.
   ```bash
   bun install
   ```

3. **Configure Environment:**
   Create a `.env` file based on `.env.example` (if provided) and fill in the necessary environment variables, including Linear OAuth credentials, GitHub tokens, Redis settings, and OpenRouter API key.

4. **Running the application:**
   You can run the development server using:
   ```bash
   bun run dev
   ```

## Roadmap

### Completed
- [x] Initial architecture definition
- [x] Job processing pipeline (BullMQ + Redis)
- [x] Linear webhook integration (AgentSessionEvent)
- [x] GitHub webhook processing
- [x] OAuth flow for app-user installation

### Planned
- [ ] Enhanced PR review feedback loop
- [ ] Improved self-learning capabilities via Redis context layer
- [ ] Refinement of the AI planning and acting performance
- [ ] Integration of more complex testing harnesses
