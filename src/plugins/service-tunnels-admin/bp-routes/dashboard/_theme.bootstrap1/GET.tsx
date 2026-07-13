/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import { js } from "jsx-htmx";
import type { DashboardData } from "../GET.js";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function renderDashboard(data: DashboardData): HtmlRenderable {
  const metrics = [
    { label: "Active tunnels", value: String(data.activeTunnels) },
    { label: "Requests handled", value: String(data.requests) },
    { label: "Data received", value: formatBytes(data.bytesIn) },
    { label: "Data sent", value: formatBytes(data.bytesOut) }
  ];

  return (
    <section class="container-fluid px-0">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <p class="text-body-secondary mb-0">Live tunnel activity and traffic.</p>
        <a class="btn btn-outline-secondary btn-sm" href="/tunnels">History</a>
      </div>

      <div class="row g-3 mb-4">
        {metrics.map((metric) => (
          <div class="col-sm-6 col-xl-3">
            <div class="border rounded-3 p-3 bg-body h-100">
              <div class="small text-body-secondary mb-1">{metric.label}</div>
              <div class="h4 mb-0">{metric.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div class="border rounded-3 bg-body">
        <div class="d-flex justify-content-between align-items-center px-3 py-2 border-bottom">
          <span class="fw-semibold">Active tunnels</span>
          <span class="badge text-bg-success">Live</span>
        </div>
        <div class="table-responsive">
          <table class="table table-sm table-hover align-middle mb-0">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Target</th>
                <th>Visitor auth</th>
                <th class="text-end">Requests</th>
                <th>Transfer</th>
                <th>Expires in</th>
              </tr>
            </thead>
            <tbody>
              {data.tunnels.length === 0 ? (
                <tr><td colspan="6" class="text-center text-body-secondary py-4">No active tunnels.</td></tr>
              ) : data.tunnels.map((tunnel) => (
                <tr>
                  <td>
                    {tunnel.publicUrl ? (
                      <a href={tunnel.publicUrl} target="_blank" rel="noopener noreferrer">
                        <code>{tunnel.publicUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}</code>
                        <span class="small"> (open)</span>
                      </a>
                    ) : <code>{tunnel.subdomain}</code>}
                  </td>
                  <td>{tunnel.target}</td>
                  <td>{tunnel.validation === "ip" ? "IP validation" : "Cookie validation"}</td>
                  <td class="text-end">{String(tunnel.requests)}</td>
                  <td class="small text-body-secondary">{formatBytes(tunnel.bytesIn)} in / {formatBytes(tunnel.bytesOut)} out</td>
                  <td class="small text-body-secondary">
                    <time datetime={tunnel.expiresAt} {...{ "data-expires-at": tunnel.expiresAt }}>calculating...</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function render(data: DashboardData): HtmlRenderable {
  return (
    <div
      hx-ext="sse"
      hx-swap="innerHTML"
      {...{ "hx-sse:connect": "/dashboard/__sse?_f=body.live" }}
    >
      {renderDashboard(data)}
      <script>{js(`
        window.updateTunnelCountdowns = function () {
          document.querySelectorAll('[data-expires-at]').forEach(function (element) {
            var seconds = Math.max(0, Math.ceil((Date.parse(element.dataset.expiresAt) - Date.now()) / 1000));
            var days = Math.floor(seconds / 86400);
            var hours = Math.floor(seconds % 86400 / 3600);
            var minutes = Math.floor(seconds % 3600 / 60);
            var remainder = seconds % 60;
            element.textContent = (days ? days + 'd ' : '') + (days || hours ? hours + 'h ' : '') + minutes + 'm ' + remainder + 's';
          });
        };
        window.updateTunnelCountdowns();
        window.tunnelCountdownTimer ||= setInterval(window.updateTunnelCountdowns, 1000);
      `)}</script>
    </div>
  );
}
