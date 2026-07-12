/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable, StreamShellContext } from "@betterportal/framework";
import type { DashboardData } from "../GET.js";
import { renderDashboard } from "./GET.js";

export function renderShell({ sseConnectPath }: StreamShellContext): HtmlRenderable {
  return (
    <div
      class="container-fluid px-0"
      hx-swap="innerHTML"
      {...{ "hx-sse:connect": sseConnectPath }}
    >
      <div class="text-center text-body-secondary py-5">Loading live tunnel data...</div>
    </div>
  );
}

export function renderItem(data: DashboardData): HtmlRenderable {
  return renderDashboard(data);
}
