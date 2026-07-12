/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { DashboardData } from "../GET.js";
import { renderDashboard } from "./GET.js";

export function render(data: DashboardData): HtmlRenderable {
  return renderDashboard(data);
}
