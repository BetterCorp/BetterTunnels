import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const schemasDir = path.join(root, "src", ".bsb", "schemas");
const orgId = packageJson.bsb?.orgId;
const packageVersion = packageJson.version;

if (!orgId || !packageVersion || !fs.existsSync(schemasDir)) {
  process.exit(0);
}

const schemaFiles = fs.readdirSync(schemasDir)
  .filter((file) => file.endsWith(".json") && !file.endsWith(".plugin.json"));

const localVersions = new Map();
for (const file of schemaFiles) {
  const filepath = path.join(schemasDir, file);
  const schema = JSON.parse(fs.readFileSync(filepath, "utf8"));
  if (typeof schema.pluginName === "string") {
    localVersions.set(schema.pluginName, schema.version || packageVersion);
  }
}

let changed = 0;
for (const file of schemaFiles) {
  const filepath = path.join(schemasDir, file);
  const schema = JSON.parse(fs.readFileSync(filepath, "utf8"));
  if (!Array.isArray(schema.dependencies)) continue;

  let schemaChanged = false;
  for (const dependency of schema.dependencies) {
    if (typeof dependency.id !== "string") continue;
    const prefix = `${orgId}/`;
    if (!dependency.id.startsWith(prefix) || !dependency.id.endsWith(".js")) continue;

    const pluginName = dependency.id.slice(prefix.length, -".js".length);
    const version = localVersions.get(pluginName);
    if (!version || dependency.version === version) continue;

    dependency.version = version;
    schemaChanged = true;
  }

  if (schemaChanged) {
    fs.writeFileSync(filepath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
    changed += 1;
  }
}

if (changed > 0) {
  console.log(`[sync-bsb-schema-dependency-versions] Updated ${changed} schema dependency file(s).`);
}
