# Contributing to B-MOE

Thanks for contributing! This guide covers setting up for local development and the conventions we follow.

## Development setup

1. **Install Bun** — see [bun.sh](https://bun.sh) for the installer.
2. **Install dependencies**:
   ```bash
   bun install
   ```
3. **Start Redis** (required for the server and most tests):
   ```bash
   bun run redis:up
   ```
4. **Copy and configure environment**:
   ```bash
   cp .env.example .env
   ```
   At minimum, set `REDIS_HOST` and any credentials you need for the services you're working on.
5. **Build the sandbox image** (if working on sandbox-related code):
   ```bash
   bun run sandbox:build
   ```
6. **Run the server**:
   ```bash
   bun run dev
   ```

### Nix

If you use [Nix](https://nixos.org), a dev shell is provided:

```bash
nix develop
```

## Code style

- **TypeScript, strict mode** — no `any`, no implicit casts.
- **Composition over inheritance** — services are classes with async methods, injected via Awilix. Workers are plain async functions that receive services from the container.
- **Models are type definitions and pure functions** — state transitions, parsing, and validation. No ORM; Redis access goes through thin helpers in `store/`.
- **Descriptive variable names** — no abbreviations except well-known ones (PR, LLM, RPC, DI).
- **Comments only when the code can't explain itself** — prefer self-documenting code.
- **Error handling** — throw specific errors, catch at the worker boundary, log and retry based on job config.
- **Formatting** — use `oxfmt` via `bun run format`.
- **Linting** — use `oxlint` via `bun run lint`.

## Testing

- **Framework** — [Bun test runner](https://bun.sh/docs/cli/test) (`bun test`).
- **What to test**:
  - Services (mock external APIs — Linear, GitHub, Docker, Pi, OpenRouter).
  - State machine transitions (see `tests/run.test.ts`).
  - Store operations (see `tests/run-store.test.ts`, `tests/linear-install-store.test.ts`).
  - Parsing and validation logic (see `tests/pi-config.test.ts`, `tests/pi-prompts.test.ts`).
- **What not to test** — workers end-to-end; focus on service-level tests instead.
- **Naming** — test files live in `tests/` and mirror the source path: `src/services/foo.service.ts` → `tests/foo-service.test.ts`.
- **Run tests**:
  ```bash
  bun run test
  ```

## Making changes

1. Create a feature branch from `main`.
2. Make your changes. Follow the code style above.
3. Add or update tests for the behavior you're changing.
4. Run the verification gates in order:
   ```bash
   bun run lint    # lint first
   bun run test    # then tests
   ```
5. Fix any failures before pushing.
6. Open a pull request with a clear description of the change and why.

## Adding a new service

Follow the existing pattern:

1. Define an **interface** (e.g., `FooClient`) and the **dependencies interface** (e.g., `FooServiceDependencies`) in the service file.
2. Implement the service class, accepting dependencies via constructor.
3. Register it in `src/config/container.ts` using `asClass(...).singleton()`. Use `.inject()` for non-container deps (fetch, clock, id generators).
4. Add the service to the `Cradle` interface.
5. Write tests in `tests/`.

## Adding a new environment variable

1. Add it to `EnvSchema` in `src/config/env.ts` (use `optionalNonEmptyString` or a specific Zod type).
2. Add the transformed key to the `.transform()` callback.
3. Add the corresponding type field to the `Env` type.
4. Add it to `.env.example` with a comment describing its purpose.
5. Update `README.md` if it's a user-facing variable.
