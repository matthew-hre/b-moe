import { z } from "zod";

const optionalNonEmptyString = z.string().min(1).optional();
const RepositoryAliasesSchema = z.record(
  z.string().min(1),
  z.union([
    z.url(),
    z.object({ url: z.url(), baseBranch: z.string().min(1).optional() }).strict(),
  ]),
);

export const EnvSchema = z
  .object({
    LINEAR_CLIENT_ID: optionalNonEmptyString,
    LINEAR_CLIENT_SECRET: optionalNonEmptyString,
    LINEAR_REDIRECT_URI: z.url().optional(),
    LINEAR_WEBHOOK_SECRET: optionalNonEmptyString,
    GITHUB_TOKEN: optionalNonEmptyString,
    GITHUB_WEBHOOK_SECRET: optionalNonEmptyString,
    OPENROUTER_API_KEY: optionalNonEmptyString,
    OPENROUTER_MODEL: optionalNonEmptyString,
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: z.coerce.number().int().positive().optional(),
    DOCKER_HOST: z.string().min(1).default("local"),
    REPO_BASE_PATH: optionalNonEmptyString,
    REPOSITORIES_JSON: optionalNonEmptyString,
    BOT_GITHUB_USERNAME: optionalNonEmptyString,
  })
  .transform((env) => ({
    linearClientId: env.LINEAR_CLIENT_ID,
    linearClientSecret: env.LINEAR_CLIENT_SECRET,
    linearRedirectUri: env.LINEAR_REDIRECT_URI,
    linearWebhookSecret: env.LINEAR_WEBHOOK_SECRET,
    githubToken: env.GITHUB_TOKEN,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET,
    openrouterApiKey: env.OPENROUTER_API_KEY,
    openrouterModel: env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite",
    redisHost: env.REDIS_HOST,
    redisPort: env.REDIS_PORT ?? 6379,
    dockerHost: env.DOCKER_HOST,
    repoBasePath: env.REPO_BASE_PATH,
    repositories: parseRepositories(env.REPOSITORIES_JSON),
    botGithubUsername: env.BOT_GITHUB_USERNAME,
  }));

export type Env = Readonly<z.infer<typeof EnvSchema>>;
export type EnvSource = Readonly<Record<string, string | undefined>>;

export function loadEnv(source: EnvSource = process.env): Env {
  return EnvSchema.parse(source);
}

function parseRepositories(value: string | undefined): Record<string, string | { url: string; baseBranch?: string }> {
  if (!value) {
    return {};
  }

  return RepositoryAliasesSchema.parse(JSON.parse(value));
}
