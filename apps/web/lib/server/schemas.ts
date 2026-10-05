// 请求体校验(类型与 packages/contracts/src/api.ts 对应)。
import {
  CLIENT_EVENT_TYPES,
  WAITLIST_ROLES,
  type ActionBody,
  type CreateInvitesBody,
  type CreateRedeemCodesBody,
  type CreateSessionBody,
  type EventBody,
  type InviteWaitlistBody,
  type RedeemBody,
  type RequestCodeBody,
  type TurnBody,
  type VerifyBody,
  type WaitlistBody,
} from "@fde/contracts";
import { z } from "zod";
import { normalizeCnMobile } from "./phone.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const id = z.string().trim().min(1).max(64);

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine((e) => EMAIL.test(e), "邮箱格式不对");

/** 第三轮:大陆手机号,转成 "+86…";不合法报"手机号格式不对"。 */
const phoneField = z
  .string()
  .max(32)
  .transform((p, ctx) => {
    const n = normalizeCnMobile(p);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "手机号格式不对" });
      return z.NEVER;
    }
    return n;
  });

const oneAddress = (b: { email?: string | undefined; phone?: string | undefined }) => (b.email === undefined) !== (b.phone === undefined);
const ONE_ADDRESS = "邮箱和手机号填一个";

/** 第三轮起 email 与 phone 二选一(phone 是否接受由 login 按 smsLoginEnabled() 决定)。 */
export const RequestCodeSchema = z
  .object({
    email: emailField.optional(),
    phone: phoneField.optional(),
    inviteCode: z.string().trim().toUpperCase().max(32).optional().nullable(),
  })
  .refine(oneAddress, ONE_ADDRESS);

export const VerifySchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254).optional(),
    phone: phoneField.optional(),
    code: z.string().trim().min(1).max(16),
  })
  .refine(oneAddress, ONE_ADDRESS);

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
    wantNext: z.boolean().nullable().optional(),
  })
  .refine(
    (b) => (b.rating !== null && b.rating !== undefined) || Boolean(b.text) || Boolean(b.dispute) || typeof b.wantNext === "boolean",
    "至少填一项(推荐意愿、文字反馈、申诉或想不想玩下一个场景)",
  );

export const CreateInvitesSchema = z.object({
  count: z.number().int().min(1).max(200),
  maxUses: z.number().int().min(1).max(10000).optional(),
  note: z.string().trim().max(200).optional(),
});

// ================================================================ 第三轮

/** 来源渠道:字母数字 - _,最长 32;不合法的直接丢掉(不报错,免得挡住登记)。 */
const sourceField = z
  .string()
  .trim()
  .max(200)
  .transform((v) => (/^[A-Za-z0-9_-]{1,32}$/.test(v) ? v : undefined))
  .optional();

export const WaitlistSchema = z.object({
  email: emailField,
  role: z.enum(WAITLIST_ROLES).optional(),
  note: z.string().trim().max(500).optional(),
  source: sourceField,
  website: z.string().max(500).optional(),
});

export const InviteWaitlistSchema = z
  .object({
    count: z.number().int().min(1).max(200).optional(),
    emails: z.array(emailField).min(1).max(200).optional(),
  })
  .refine((b) => (b.count === undefined) !== (b.emails === undefined), "count 和 emails 给一个");

const eventProp = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
export const EventSchema = z.object({
  type: z.enum(CLIENT_EVENT_TYPES),
  sessionId: z.string().trim().min(1).max(64).optional(),
  props: z
    .record(z.string().max(32), eventProp)
    .refine((p) => Object.keys(p).length <= 10, "props 最多 10 个键")
    .optional(),
});

export const RedeemSchema = z.object({ code: z.string().trim().min(1).max(64) });

export const CreateRedeemCodesSchema = z.object({
  productId: id,
  count: z.number().int().min(1).max(500),
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
  Assignable<WaitlistBody, z.infer<typeof WaitlistSchema>>,
  Assignable<InviteWaitlistBody, z.infer<typeof InviteWaitlistSchema>>,
  Assignable<EventBody, z.infer<typeof EventSchema>>,
  Assignable<RedeemBody, z.infer<typeof RedeemSchema>>,
  Assignable<CreateRedeemCodesBody, z.infer<typeof CreateRedeemCodesSchema>>,
];
