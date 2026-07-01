import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pluginsDir = join(root, "src", "plugins");
const activePlugins = new Set(
  existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []
);

for (const dir of [join(root, "src", ".bsb", "schemas"), join(root, "src", ".bsb", "clients")]) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const pluginName = entry.name.replace(/\.(json|ts|js|d\.ts|map)$/, "");
    if (!activePlugins.has(pluginName)) {
      rmSync(join(dir, entry.name), { force: true });
    }
  }
}

for (const generatedManifest of ["bsb-plugin.json", "bsb-tests.json"]) {
  rmSync(join(root, generatedManifest), { force: true });
}
