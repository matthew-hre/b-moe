export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_AGENT_SCOPES = "read,write,app:assignable,app:mentionable";

export interface BuildLinearOAuthAuthorizeUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly promptConsent?: boolean;
}

export function buildLinearOAuthAuthorizeUrl({
  clientId,
  redirectUri,
  state,
  promptConsent = false,
}: BuildLinearOAuthAuthorizeUrlInput): URL {
  const authorizeUrl = new URL(LINEAR_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", LINEAR_AGENT_SCOPES);
  authorizeUrl.searchParams.set("actor", "app");

  if (state) {
    authorizeUrl.searchParams.set("state", state);
  }

  if (promptConsent) {
    authorizeUrl.searchParams.set("prompt", "consent");
  }

  return authorizeUrl;
}
