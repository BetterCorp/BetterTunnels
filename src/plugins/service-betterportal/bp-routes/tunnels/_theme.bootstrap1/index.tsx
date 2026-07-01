/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { ResponseData } from "../index.js";

export function render(data: ResponseData): HtmlRenderable {
  return (
    <section class="container-fluid px-0">
      <div class="d-flex justify-content-between align-items-start mb-4">
        <div>
          <h1 class="h3 mb-1">BetterTunnels</h1>
          <p class="text-body-secondary mb-0">Live tunnel sessions and recent usage.</p>
        </div>
        <div class="text-end">
          <div class="h4 mb-0">{String(data.active)}</div>
          <div class="small text-body-secondary">active / {String(data.total)} shown</div>
        </div>
      </div>

      <div class="card border-0 shadow-sm">
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead>
              <tr>
                <th>Subdomain</th>
                <th>Target</th>
                <th>Status</th>
                <th>Mode</th>
                <th class="text-end">Requests</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {data.tunnels.length === 0 ? (
                <tr>
                  <td colspan="6" class="text-center text-body-secondary py-4">No tunnels yet.</td>
                </tr>
              ) : data.tunnels.map((tunnel) => (
                <tr>
                  <td>
                    <code>{tunnel.subdomain}</code>
                    <div class="small text-body-secondary">{tunnel.ownerServerId ?? "no owner"}</div>
                  </td>
                  <td>{tunnel.target}</td>
                  <td><span class={`badge ${tunnel.status === "active" ? "text-bg-success" : "text-bg-secondary"}`}>{tunnel.status}</span></td>
                  <td>{tunnel.authenticated ? "authenticated" : "anonymous"}</td>
                  <td class="text-end">{String(tunnel.requests)}</td>
                  <td class="small text-body-secondary">{new Date(tunnel.expiresAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
