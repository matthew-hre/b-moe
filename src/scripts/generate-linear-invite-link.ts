import { LINEAR_AGENT_SCOPES, buildLinearOAuthAuthorizeUrl } from "../services/linear-oauth-url";

const DEFAULT_PORT = "3000";
const CALLBACK_PATH = "/oauth/linear/callback";

interface ScriptOptions {
  readonly clientId?: string;
  readonly redirectUri?: string;
  readonly baseUrl?: string;
  readonly state?: string;
  readonly promptConsent: boolean;
  readonly help: boolean;
}

function getOption(args: readonly string[], name: string): string | undefined {
  const inlinePrefix = `${name}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));

  if (inlineValue) {
    return inlineValue.slice(inlinePrefix.length);
  }

  const optionIndex = args.indexOf(name);

  if (optionIndex === -1) {
    return undefined;
  }

  return args[optionIndex + 1];
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

export function parseOptions(args: readonly string[]): ScriptOptions {
  return {
    clientId: getOption(args, "--client-id"),
    redirectUri: getOption(args, "--redirect-uri"),
    baseUrl: getOption(args, "--base-url"),
    state: getOption(args, "--state"),
    promptConsent: hasFlag(args, "--prompt-consent"),
    help: hasFlag(args, "--help") || hasFlag(args, "-h"),
  };
}

function appendCallbackPath(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = CALLBACK_PATH;
  url.search = "";
  url.hash = "";

  return url.toString();
}

function getDefaultRedirectUri(env: NodeJS.ProcessEnv): string {
  const port = env.PORT ?? DEFAULT_PORT;

  return `http://localhost:${port}${CALLBACK_PATH}`;
}

export function resolveRedirectUri(options: ScriptOptions, env: NodeJS.ProcessEnv): string {
  if (options.redirectUri) {
    return options.redirectUri;
  }

  if (env.LINEAR_REDIRECT_URI) {
    return env.LINEAR_REDIRECT_URI;
  }

  if (options.baseUrl) {
    return appendCallbackPath(options.baseUrl);
  }

  return getDefaultRedirectUri(env);
}

function writeOutput(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function printHelp(): void {
  writeOutput(`Generate a Linear agent install URL.

Usage:
  bun run linear:invite [options]

Options:
  --client-id <id>        Linear OAuth client id. Defaults to LINEAR_CLIENT_ID.
  --redirect-uri <url>    Full OAuth callback URL. Defaults to LINEAR_REDIRECT_URI.
  --base-url <url>        Public app base URL; callback path is appended automatically.
  --state <value>         Optional OAuth state value.
  --prompt-consent        Force Linear to show the consent screen.
  -h, --help              Show this help.

Examples:
  bun run linear:invite --base-url https://example.ngrok-free.app
  bun run linear:invite --redirect-uri https://example.ngrok-free.app/oauth/linear/callback
`);
}

export function main(args: readonly string[] = Bun.argv.slice(2), env: NodeJS.ProcessEnv = process.env): number {
  const options = parseOptions(args);

  if (options.help) {
    printHelp();
    return 0;
  }

  const clientId = options.clientId ?? env.LINEAR_CLIENT_ID;

  if (!clientId) {
    writeError("Missing LINEAR_CLIENT_ID. Set it in .env or pass --client-id <id>.");
    return 1;
  }

  const redirectUri = resolveRedirectUri(options, env);
  const installUrl = buildLinearOAuthAuthorizeUrl({
    clientId,
    redirectUri,
    state: options.state,
    promptConsent: options.promptConsent,
  });

  writeOutput("Linear agent install URL:\n");
  writeOutput(installUrl.toString());
  writeOutput("\nInstall notes:");
  writeOutput("- Open this URL as a Linear workspace admin.");
  writeOutput(`- OAuth callback URL configured in Linear must be: ${redirectUri}`);
  writeOutput(`- Requested scopes: ${LINEAR_AGENT_SCOPES}`);
  writeOutput("- Actor: app");

  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
