// GET /api/scenarios —— 场景列表(不需要登录)。
import type { ScenariosResponse } from "@fde/contracts";
import { handle, json } from "../../../lib/server/http.ts";
import { scenarios, scenarioSummary } from "../../../lib/server/scenarios.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const body: ScenariosResponse = { scenarios: [...scenarios().values()].map(({ scn }) => scenarioSummary(scn)) };
    return json(body);
  });
}
