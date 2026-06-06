import { z } from "zod";

export const LinearWebhookActionSchema = z.enum(["create", "update", "remove"]);
export const LinearWebhookTypeSchema = z.enum(["Issue"]);

export const LinearIssueUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    email: z.email().optional(),
    url: z.url().optional(),
  })
  .loose();

export const LinearIssueDataSchema = z
  .object({
    id: z.string().min(1),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
    number: z.number().int().positive().optional(),
    title: z.string().min(1).optional(),
    identifier: z.string().min(1).optional(),
    url: z.url().optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    assignee: LinearIssueUserSchema.nullable().optional(),
  })
  .loose();

export const LinearIssueWebhookEventSchema = z
  .object({
    action: LinearWebhookActionSchema,
    type: LinearWebhookTypeSchema,
    actor: z.unknown().optional(),
    createdAt: z.iso.datetime(),
    data: LinearIssueDataSchema,
    url: z.url().optional(),
    updatedFrom: z.record(z.string(), z.unknown()).optional(),
    organizationId: z.string().min(1).optional(),
    webhookTimestamp: z.number().int().nonnegative(),
    webhookId: z.string().min(1).optional(),
  })
  .loose();

export const LinearOtherWebhookEventSchema = z
  .object({
    type: z.string().min(1).refine((type) => type !== "Issue"),
    action: z.string().min(1),
    createdAt: z.iso.datetime().optional(),
    webhookTimestamp: z.number().int().nonnegative().optional(),
  })
  .loose();

export const LinearWebhookEventSchema = z.union([
  LinearIssueWebhookEventSchema,
  LinearOtherWebhookEventSchema,
]);

export type LinearIssueWebhookEvent = Readonly<z.infer<typeof LinearIssueWebhookEventSchema>>;
export type LinearWebhookEvent = Readonly<z.infer<typeof LinearWebhookEventSchema>>;

export function getAssignedLinearIssueId(event: LinearWebhookEvent): string | undefined {
  const parseResult = LinearIssueWebhookEventSchema.safeParse(event);

  if (!parseResult.success) {
    return undefined;
  }

  const issueEvent = parseResult.data;

  if (!issueEvent.data.assigneeId && !issueEvent.data.assignee) {
    return undefined;
  }

  if (issueEvent.action === "create") {
    return issueEvent.data.id;
  }

  if (issueEvent.action !== "update") {
    return undefined;
  }

  if (!issueEvent.updatedFrom) {
    return undefined;
  }

  if (!("assigneeId" in issueEvent.updatedFrom) && !("assignee" in issueEvent.updatedFrom)) {
    return undefined;
  }

  return issueEvent.data.id;
}
