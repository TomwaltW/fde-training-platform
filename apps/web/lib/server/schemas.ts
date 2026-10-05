// 请求体校验(类型与 packages/contracts/src/api.ts 对应)。
import type { ActionBody, CreateInvitesBody, CreateSessionBody, RequestCodeBody, TurnBody, VerifyBody } from "@fde/contracts";
import { z } from "zod";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = z.string().trim().min(1).max(64);

export const RequestCodeSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((e) => EMAIL.test(e), "邮箱格式不对"),
  inviteCode: z.string().trim().toUpperCase().max(32).optional().nullable(),
});

export const VerifySchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  code: z.string().trim().min(1).max(16),
});

export const CreateSessionSchema = z.object({ scenarioId: id });

/** 字数上限(500 字)由引擎的输入审核负责,这里只挡明显异常的请求。 */
export const TurnSchema = z.object({ text: z.string().max(5000) });

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("switch_role"), role: id }),
  z.object({ type: z.literal("open_artifact"), artifact: id }),
  z.object({ type: z.literal("action"), action: id }),
  z.object({ type: z.literal("experiment"), experiment: id }),
  z.object({ type: z.literal("submit_judgment"), form: z.record(z.string().max(64), z.string().max(2000)) }),
  z.object({ type: z.literal("end") }),
]);

export const FeedbackSchema = z
  .object({
    rating: z.number().int().min(0).max(10).nullable().optional(),
    text: z.string().trim().max(2000).nullable().optional(),
    dispute: z
      .object({ dimension: z.string().trim().min(1).max(64), reason: z.string().trim().min(1).max(2000) })
      .nullable()
      .optional(),
  })
  .refine((b) => (b.rating !== null && b.rating !== undefined) || Boolean(b.text) || Boolean(b.dispute), "至少填一项(推荐意愿、文字反馈或申诉)");

export const CreateInvitesSchema = z.object({
  count: z.number().int().min(1).max(200),
  maxUses: z.number().int().min(1).max(10000).optional(),
  note: z.string().trim().max(200).optional(),
});

// 编译期检查:校验后的类型能当成契约里的请求体用
type Assignable<T, _U extends T> = true;
export type _SchemaChecks = [
  Assignable<RequestCodeBody, Omit<z.infer<typeof RequestCodeSchema>, "inviteCode">>,
  Assignable<VerifyBody, z.infer<typeof VerifySchema>>,
  Assignable<CreateSessionBody, z.infer<typeof CreateSessionSchema>>,
  Assignable<TurnBody, z.infer<typeof TurnSchema>>,
  Assignable<ActionBody, z.infer<typeof ActionSchema>>,
  Assignable<CreateInvitesBody, z.infer<typeof CreateInvitesSchema>>,
];
