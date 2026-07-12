import { setTimeout as delay } from "node:timers/promises";
import type { SSEHandlerContext } from "@betterportal/framework";
import { DashboardSchema, loadDashboard, type DashboardData } from "./GET.js";

export const tickSchema = DashboardSchema;

export async function* handleSSE(_ctx: SSEHandlerContext): AsyncGenerator<DashboardData> {
  while (true) {
    yield await loadDashboard();
    await delay(5_000);
  }
}
