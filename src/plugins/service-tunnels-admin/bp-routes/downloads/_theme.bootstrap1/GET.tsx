/** @jsxImportSource jsx-htmx */
import type { HtmlRenderable } from "@betterportal/framework";
import type { ResponseData } from "../GET.js";

export function render(data: ResponseData): HtmlRenderable {
  return (
    <section class="container-fluid px-0">
      <div class="mb-4">
        <img
          src={data.logoUrl}
          alt="BetterTunnels"
          class="img-fluid mb-3"
          style="max-width: 280px; height: auto;"
        />
        <h1 class="h3 mb-1">BetterTunnels CLI</h1>
        <p class="text-body-secondary mb-0">Download the CLI and start a public development tunnel.</p>
      </div>

      <div class="row g-4">
        <div class="col-lg-5">
          <div class="border rounded-3 p-4 bg-body h-100">
            <h2 class="h5 mb-3">Quick start</h2>
            {data.examples.map((example) => (
              <pre class="small bg-body-tertiary border rounded-2 p-3 mb-2"><code>{example}</code></pre>
            ))}
          </div>
        </div>
        <div class="col-lg-7">
          <div class="border rounded-3 bg-body h-100">
            <div class="px-3 py-2 border-bottom d-flex justify-content-between">
              <span class="fw-semibold">Release assets</span>
              <span class="text-body-secondary">{data.latestTag}</span>
            </div>
            <div class="table-responsive">
              <table class="table table-sm align-middle mb-0">
                <thead>
                  <tr>
                    <th>OS</th>
                    <th>Arch</th>
                    <th>Artifact</th>
                  </tr>
                </thead>
                <tbody>
                  {data.downloads.map((download) => (
                    <tr>
                      <td>{download.os}</td>
                      <td>{download.arch}</td>
                      <td><code>{download.artifact}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
