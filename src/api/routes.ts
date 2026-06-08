import { createHmac } from "node:crypto";
import { LinearWebhookClient } from "@linear/sdk/webhooks";
import type { AwilixContainer } from "awilix";
import { createLogger } from "../logger";
import type { Cradle } from "../config/container";
import { getAgentSessionTrigger, LinearWebhookEventSchema } from "../models/linear";
import type { AgentSessionEventLike } from "../models/linear";
import { AgentSessionTriggerService } from "../services/agent-session-trigger.service";
import {
  LinearOAuthExchangeError,
  MissingLinearOAuthConfigError,
} from "../services/linear-oauth.service";
import { buildLinearOAuthAuthorizeUrl } from "../services/linear-oauth-url";

const logger = createLogger("routes");

interface Routes {
  fetch(request: Request): Promise<Response>;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

async function handleAgentSessionTrigger(
  trigger: ReturnType<typeof getAgentSessionTrigger>,
  service: AgentSessionTriggerService,
): Promise<Response> {
  const result = await service.handle(trigger);
  return jsonResponse(result);
}

export function createRoutes(container: AwilixContainer<Cradle>): Routes {
  const webhookSecret = container.cradle.env.linearWebhookSecret;
  const webhookClient = webhookSecret ? new LinearWebhookClient(webhookSecret) : undefined;

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
        logger.info("received Linear OAuth callback");
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
        logger.info("received Linear webhook");

        if (webhookClient && webhookSecret) {
          const rawBody = Buffer.from(await request.arrayBuffer());
          const signature = request.headers.get("linear-signature");
          const timestampHeader = request.headers.get("linear-timestamp");

          logger.info(
            `webhook signature=${signature ? (signature.length > 12 ? signature.substring(0, 12) + "..." : signature) : "missing"} timestampHeader=${timestampHeader ?? "missing"} bodyLength=${rawBody.length}`,
          );

          if (!signature) {
            logger.warn("webhook missing linear-signature header");
            return jsonResponse({ error: "Missing Linear webhook signature" }, { status: 401 });
          }

          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
          } catch {
            logger.warn("webhook body is not valid JSON");
            return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
          }

          // Replicate the SDK's verification: sign the raw body and check the
          // replay window against the body's webhookTimestamp, falling back to
          // the linear-timestamp header. `verify` throws on a bad signature or
          // a stale timestamp.
          const timestamp =
            (typeof payload.webhookTimestamp === "number" ? payload.webhookTimestamp : undefined) ??
            timestampHeader ??
            undefined;

          try {
            webhookClient.verify(rawBody, signature, timestamp);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
            logger.error(
              `webhook verification failed: ${message} (configured secretLength=${webhookSecret.length} expectedSignature=${expected.substring(0, 12)}... receivedSignature=${signature.substring(0, 12)}...)`,
            );
            return jsonResponse({ error: "Invalid Linear webhook signature" }, { status: 401 });
          }

          logger.info(
            `webhook verified; type=${payload.type ?? "unknown"} action=${payload.action ?? "none"}`,
          );

          if (payload.type !== "AgentSessionEvent") {
            logger.info(`webhook type=${payload.type ?? "unknown"} ignored`);
            return jsonResponse({ ignored: true });
          }

          try {
            const trigger = getAgentSessionTrigger(payload as unknown as AgentSessionEventLike);
            return await handleAgentSessionTrigger(trigger, container.cradle.agentSessionTriggerService);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`webhook processing failed: ${message}`);
            return jsonResponse({ error: "Linear webhook processing failed" }, { status: 500 });
          }
        }

        const rawBody = Buffer.from(await request.arrayBuffer());
        let body: unknown;

        try {
          body = JSON.parse(rawBody.toString());
        } catch {
          return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
        }

        const parseResult = LinearWebhookEventSchema.safeParse(body);

        if (!parseResult.success) {
          logger.warn("invalid Linear webhook payload");
          return jsonResponse({ error: "Invalid Linear webhook payload" }, { status: 400 });
        }

        logger.info(
          `Linear webhook parsed type=${parseResult.data.type} action=${"action" in parseResult.data ? parseResult.data.action : "none"}`,
        );

        if (parseResult.data.type === "AgentSessionEvent") {
          const trigger = getAgentSessionTrigger(
            parseResult.data as unknown as AgentSessionEventLike,
          );
          return await handleAgentSessionTrigger(trigger, container.cradle.agentSessionTriggerService);
        }

        logger.info(`Linear webhook type=${parseResult.data.type} ignored`);
        return jsonResponse({ ignored: true });
      }

      return new Response("Not Found", { status: 404 });
    },
  };
}