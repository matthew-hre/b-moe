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

export const AgentSessionSchema = z
  .object({
    id: z.string().min(1),
    issue: AgentSessionIssueSchema.nullable().optional(),
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

// A normalized view of an AgentSessionEvent with the fields a run needs. A
// `created` event starts a run; a `prompted` event resumes an existing one.
export interface AgentSessionTrigger {
  readonly action: AgentSessionEventAction;
  readonly agentSessionId: string;
  readonly linearIssueId?: string;
  readonly promptContext?: string;
  readonly promptBody?: string;
  readonly stopRequested: boolean;
}

export function getAgentSessionTrigger(
  event: LinearWebhookEvent,
): AgentSessionTrigger | undefined {
  const parseResult = AgentSessionEventWebhookSchema.safeParse(event);

  if (!parseResult.success) {
    return undefined;
  }

  const sessionEvent = parseResult.data;

  return {
    action: sessionEvent.action,
    agentSessionId: sessionEvent.agentSession.id,
    linearIssueId: sessionEvent.agentSession.issue?.id,
    promptContext: sessionEvent.promptContext,
    promptBody: sessionEvent.agentActivity?.body,
    stopRequested: sessionEvent.agentActivity?.signal === "stop",
  };
}
