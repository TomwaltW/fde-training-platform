// GET /api/site —— 页脚公示(不需要登录)。
import type { SiteInfo } from "@fde/contracts";
import { AI_DIALOGUE_NOTICE } from "@fde/engine";
import { optionalEnv } from "../../../lib/server/env.ts";
import { handle, json } from "../../../lib/server/http.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const body: SiteInfo = {
      aiNotice: AI_DIALOGUE_NOTICE,
      modelDisclosure: optionalEnv("SITE_MODEL_DISCLOSURE"),
      icpNumber: optionalEnv("SITE_ICP_NUMBER"),
      publicSecurityNumber: optionalEnv("SITE_PUBLIC_SECURITY_NUMBER"),
      inviteOnly: true,
    };
    return json(body);
  });
}
