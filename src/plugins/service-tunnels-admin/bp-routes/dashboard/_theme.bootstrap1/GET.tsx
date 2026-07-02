/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { ResponseData } from "../GET.js";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function render(data: ResponseData): HtmlRenderable {
  const metrics = [
    { label: "Active tunnels", value: String(data.activeTunnels) },
    { label: "Total tunnels", value: String(data.totalTunnels) },
    { label: "Anonymous accounts", value: String(data.anonymousAccounts) },
    { label: "Registered accounts", value: String(data.registeredAccounts) },
    { label: "Requests", value: String(data.requests) },
    { label: "Transfer", value: `${formatBytes(data.bytesIn)} in / ${formatBytes(data.bytesOut)} out` }
  ];

  return (
    <section class="container-fluid px-0">
      <div class="d-flex justify-content-between align-items-start mb-4">
        <div>
          <h1 class="h3 mb-1">BetterTunnels Dashboard</h1>
          <p class="text-body-secondary mb-0">Platform health, usage, and recent audit activity.</p>
        </div>
        <a class="btn btn-outline-secondary btn-sm" href="/tunnels">Tunnel sessions</a>
      </div>

      <div class="row g-3 mb-4">
        {metrics.map((metric) => (
          <div class="col-sm-6 col-xl-4">
            <div class="border rounded-3 p-3 bg-body h-100">
              <div class="small text-body-secondary mb-1">{metric.label}</div>
              <div class="h4 mb-0">{metric.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div class="border rounded-3 bg-body">
        <div class="px-3 py-2 border-bottom fw-semibold">Recent audit events</div>
        <div class="table-responsive">
          <table class="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th>Event</th>
                <th>Subject</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAuditEvents.length === 0 ? (
                <tr><td colspan="3" class="text-center text-body-secondary py-4">No audit events yet.</td></tr>
              ) : data.recentAuditEvents.map((event) => (
                <tr>
                  <td><code>{event.event}</code></td>
                  <td class="text-body-secondary">{event.subjectId ?? "none"}</td>
                  <td class="text-body-secondary">{new Date(event.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
