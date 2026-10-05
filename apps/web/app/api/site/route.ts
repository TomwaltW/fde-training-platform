// T1 owns this file. T0 placeholder:验证 Next 能编译直接引用引擎(.ts 扩展名导入、node:fs)的路由。
import { resolve } from "node:path";
import { loadScenario } from "@fde/engine";
import type { SiteInfo } from "@fde/contracts";

export const dynamic = "force-dynamic";

export async function GET() {
  const root = process.env.FDE_ROOT ?? resolve(process.cwd(), "../..");
  const scn = loadScenario(resolve(root, "scenarios/freight-docs"));
  const body: SiteInfo & { _skeleton: string } = {
    aiNotice: "对话内容由 AI 生成",
    modelDisclosure: null,
    icpNumber: null,
    publicSecurityNumber: null,
    inviteOnly: true,
    _skeleton: scn.data.meta.title,
  };
  return Response.json(body);
}
