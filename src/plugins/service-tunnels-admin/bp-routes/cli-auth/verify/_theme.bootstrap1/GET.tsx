/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { ResponseData } from "../GET.js";

export function render(data: ResponseData): HtmlRenderable {
  const ok = data.status === "approved";
  return (
    <section class="container py-5">
      <div class={`border rounded-3 p-4 ${ok ? "bg-body" : "bg-danger-subtle border-danger"}`}>
        <div class={`text-uppercase fw-semibold small mb-2 ${ok ? "text-success" : "text-danger"}`}>
          BetterTunnels CLI
        </div>
        <h1 class="h3 mb-3">{ok ? "Authenticated" : "Authentication failed"}</h1>
        <p class="lead mb-0">{data.message}</p>
      </div>
    </section>
  );
}
