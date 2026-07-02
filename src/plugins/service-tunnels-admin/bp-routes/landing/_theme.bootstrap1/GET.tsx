/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { ResponseData } from "../GET.js";

export function render(data: ResponseData): HtmlRenderable {
  return (
    <main class="container-fluid px-0">
      <section class="py-5">
        <div class="row align-items-center g-5">
          <div class="col-lg-7">
            <img
              src={data.logoUrl}
              alt="BetterTunnels"
              class="img-fluid mb-4"
              style="max-width: 360px; height: auto;"
            />
            <div class="mb-3 text-uppercase fw-semibold text-danger small">{data.domain}</div>
            <h1 class="display-4 fw-semibold mb-3">Public dev tunnels with a verification gate</h1>
            <p class="lead text-body-secondary mb-4">
              Public development tunnels with explicit visitor verification, operator visibility,
              and a CLI workflow designed for local projects.
            </p>
            <div class="d-flex flex-wrap gap-2">
              <a class="btn btn-danger btn-lg" href="/downloads">Get the CLI</a>
              <a class="btn btn-outline-secondary btn-lg" href="/dashboard">Open dashboard</a>
            </div>
          </div>
          <div class="col-lg-5">
            <div class="border rounded-3 bg-body-tertiary p-3 shadow-sm">
              <div class="d-flex align-items-center justify-content-between border-bottom pb-2 mb-3">
                <span class="d-flex align-items-center gap-2 fw-semibold">
                  <img src={data.faviconUrl} alt="" width="24" height="24" />
                  local project
                </span>
                <span class="badge text-bg-danger">public</span>
              </div>
              <div class="text-center py-3">
                <img
                  src={data.markUrl}
                  alt=""
                  class="img-fluid rounded-3"
                  style="max-width: 180px;"
                />
              </div>
              <pre class="mb-3 small"><code>{data.cliInstall[0]}</code></pre>
              <div class="bg-body border rounded-2 p-3 small">
                <div class="text-body-secondary mb-1">Tunnel URL</div>
                <code>https://a1b2c3-port3100-203-0-113-10.{data.domain}</code>
              </div>
              <div class="row g-2 mt-2 small">
                <div class="col-4"><div class="border rounded-2 p-2 bg-body">verify</div></div>
                <div class="col-4"><div class="border rounded-2 p-2 bg-body">proxy</div></div>
                <div class="col-4"><div class="border rounded-2 p-2 bg-body">trace</div></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="py-4 border-top">
        <div class="row g-3">
          {data.highlights.map((item) => (
            <div class="col-md-4">
              <div class="h-100 border rounded-3 p-4 bg-body">
                <h2 class="h5 mb-2">{item.title}</h2>
                <p class="text-body-secondary mb-0">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section class="py-4 border-top">
        <div class="row g-4 align-items-start">
          <div class="col-lg-5">
            <h2 class="h4 mb-2">Managed by BetterPortal</h2>
            <p class="text-body-secondary mb-0">
              The public site, dashboard, and future account controls run as BetterPortal routes.
              Tunnel traffic can stay on separate infrastructure while this service manages the UI.
            </p>
          </div>
          <div class="col-lg-7">
            <ul class="list-group list-group-flush border rounded-3">
              {data.limits.map((limit) => (
                <li class="list-group-item d-flex gap-2 align-items-start">
                  <span class="text-danger fw-bold">!</span>
                  <span>{limit}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </main>
  );
}
