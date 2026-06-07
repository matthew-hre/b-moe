import { z } from "zod";

export const AgentSessionEventActionSchema = z.enum(["created", "prompted"]);
export type AgentSessionEventAction = z.infer<typeof AgentSessionEventActionSchema>;

export const AgentSessionIssueSchema = z
  .object({
    id: z.string().min(1),
    identifier: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    url: z.url().optional(),
  })
  .loose();

export const AgentSessionCreatorSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    url: z.url().optional(),
  })
  .loose();

export const AgentSessionSchema = z
  .object({
    id: z.string().min(1),
    issue: AgentSessionIssueSchema.nullable().optional(),
    creator: AgentSessionCreatorSchema.nullable().optional(),
  })
  .loose();

export const AgentActivitySchema = z
  .object({
    body: z.string().optional(),
    signal: z.string().optional(),
  })
  .loose();

export const AgentSessionEventWebhookSchema = z
  .object({
    type: z.literal("AgentSessionEvent"),
    action: AgentSessionEventActionSchema,
    createdAt: z.iso.datetime().optional(),
    agentSession: AgentSessionSchema,
    promptContext: z.string().optional(),
    agentActivity: AgentActivitySchema.nullable().optional(),
    previousComments: z.unknown().optional(),
    guidance: z.unknown().optional(),
    organizationId: z.string().min(1).optional(),
    webhookTimestamp: z.number().int().nonnegative().optional(),
    webhookId: z.string().min(1).optional(),
  })
  .loose();

export const OtherLinearWebhookEventSchema = z
  .object({
    type: z.string().min(1).refine((type) => type !== "AgentSessionEvent"),
    action: z.string().min(1).optional(),
  })
  .loose();

export const LinearWebhookEventSchema = z.union([
  AgentSessionEventWebhookSchema,
  OtherLinearWebhookEventSchema,
]);

export type AgentSessionEventWebhook = Readonly<z.infer<typeof AgentSessionEventWebhookSchema>>;
export type LinearWebhookEvent = Readonly<z.infer<typeof LinearWebhookEventSchema>>;

export interface AgentSessionTrigger {
  readonly action: AgentSessionEventAction;
  readonly agentSessionId: string;
  readonly linearIssueId?: string;
  readonly requesterUrl?: string;
  readonly requesterName?: string;
  readonly promptContext?: string;
  readonly promptBody?: string;
  readonly stopRequested: boolean;
}

export interface AgentSessionEventLike {
  action: string;
  agentSession: {
    id: string;
    issue?: { id?: string } | null;
    creator?: { url?: string; name?: string } | null;
  };
  promptContext?: string | null;
  agentActivity?: { content?: { body?: string } | null; body?: string; signal?: string } | null;
}

export function getAgentSessionTrigger(
  event: AgentSessionEventLike,
): AgentSessionTrigger | undefined {
  if (event.action !== "created" && event.action !== "prompted") {
    return undefined;
  }

  return {
    action: event.action,
    agentSessionId: event.agentSession.id,
    linearIssueId: event.agentSession.issue?.id,
    requesterUrl: event.agentSession.creator?.url,
    requesterName: event.agentSession.creator?.name,
    promptContext: event.promptContext ?? undefined,
    promptBody: event.agentActivity?.content?.body ?? event.agentActivity?.body,
    stopRequested: event.agentActivity?.signal === "stop",
  };
}
