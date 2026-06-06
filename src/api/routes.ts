import { createHmac, timingSafeEqual } from "node:crypto";
import type { AwilixContainer } from "awilix";
import type { Cradle } from "../config/container";
import { getAgentSessionTrigger, LinearWebhookEventSchema } from "../models/linear";
import {
  LinearOAuthExchangeError,
  MissingLinearOAuthConfigError,
} from "../services/linear-oauth.service";
import { buildLinearOAuthAuthorizeUrl } from "../services/linear-oauth-url";

interface Routes {
  fetch(request: Request): Promise<Response>;
}

const B_MOE_GREETING = "Hi, I'm B-MOE!";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

// Verify the `linear-signature` HMAC over the raw request body. Returns true
// when no secret is configured (e.g. local dev) so the app still works without
// one, but enforces verification whenever a secret is set.
function isValidLinearSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) {
    return true;
  }

  if (!signatureHeader) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const signatureBuffer = Buffer.from(signatureHeader, "hex");

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

export function createRoutes(container: AwilixContainer<Cradle>): Routes {
  return {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ status: "ok" });
      }

      if (url.pathname === "/runs" && request.method === "GET") {
        const runs = await container.cradle.runStore.listRuns();

        return jsonResponse({ runs });
      }

      if (url.pathname === "/oauth/linear/authorize" && request.method === "GET") {
        const { linearClientId, linearRedirectUri } = container.cradle.env;

        if (!linearClientId) {
          return jsonResponse(
            { error: "Missing Linear OAuth configuration", missingKeys: ["LINEAR_CLIENT_ID"] },
            { status: 500 },
          );
        }

        const redirectUri = linearRedirectUri ?? `${url.origin}/oauth/linear/callback`;
        const authorizeUrl = buildLinearOAuthAuthorizeUrl({
          clientId: linearClientId,
          redirectUri,
        });

        return new Response(null, {
          status: 302,
          headers: { Location: authorizeUrl.toString() },
        });
      }

      if (url.pathname === "/oauth/linear/callback" && request.method === "GET") {
        const oauthError = url.searchParams.get("error");

        if (oauthError) {
          return jsonResponse(
            { error: "Linear OAuth authorization failed", linearError: oauthError },
            { status: 400 },
          );
        }

        const code = url.searchParams.get("code");

        if (!code) {
          return jsonResponse({ error: "Missing Linear OAuth code" }, { status: 400 });
        }

        const redirectUri = container.cradle.env.linearRedirectUri ?? `${url.origin}${url.pathname}`;

        try {
          const install = await container.cradle.linearOAuthService.installFromAuthorizationCode({
            code,
            redirectUri,
          });

          return jsonResponse({
            installed: true,
            linearAppUserId: install.linearAppUserId,
            expiresIn: install.expiresIn,
            scope: install.scope,
            hasRefreshToken: install.hasRefreshToken,
          });
        } catch (error) {
          if (error instanceof MissingLinearOAuthConfigError) {
            return jsonResponse(
              { error: "Missing Linear OAuth configuration", missingKeys: error.missingKeys },
              { status: 500 },
            );
          }

          if (error instanceof LinearOAuthExchangeError) {
            return jsonResponse({ error: error.message }, { status: 502 });
          }

          throw error;
        }
      }

      if (url.pathname === "/webhook/linear" && request.method === "POST") {
        const rawBody = await request.text();

        if (
          !isValidLinearSignature(
            rawBody,
            request.headers.get("linear-signature"),
            container.cradle.env.linearWebhookSecret,
          )
        ) {
          return jsonResponse({ error: "Invalid Linear webhook signature" }, { status: 401 });
        }

        let body: unknown;

        try {
          body = JSON.parse(rawBody);
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
        }

        const parseResult = LinearWebhookEventSchema.safeParse(body);

        if (!parseResult.success) {
          return jsonResponse({ error: "Invalid Linear webhook payload" }, { status: 400 });
        }

        const trigger = getAgentSessionTrigger(parseResult.data);

        if (!trigger) {
          return jsonResponse({ ignored: true });
        }

        const { linearService, runStore } = container.cradle;

        if (trigger.action === "created") {
          // Idempotent: Linear may redeliver a `created` event for the same session.
          const existingRun = await runStore.getRunByAgentSession(trigger.agentSessionId);

          if (existingRun) {
            return jsonResponse({ run: existingRun });
          }

          const run = await runStore.createRun({
            agentSessionId: trigger.agentSessionId,
            linearIssueId: trigger.linearIssueId,
          });
          await linearService.emitActivity(trigger.agentSessionId, {
            type: "thought",
            body: B_MOE_GREETING,
          });

          return jsonResponse({ run });
        }

        // action === "prompted": a human replied into an existing session.
        const run = await runStore.getRunByAgentSession(trigger.agentSessionId);

        if (!run) {
          return jsonResponse({ ignored: true });
        }

        await linearService.emitActivity(trigger.agentSessionId, {
          type: "response",
          body: B_MOE_GREETING,
        });

        return jsonResponse({ run });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}
