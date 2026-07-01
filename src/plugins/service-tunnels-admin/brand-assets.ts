import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BrandAssets = {
  logoUrl: string;
  markUrl: string;
  faviconUrl: string;
};

let cached: BrandAssets | undefined;

const assetRoot = join(dirname(fileURLToPath(import.meta.url)), "assets/brand");

export async function loadBrandAssets(): Promise<BrandAssets> {
  if (cached) return cached;

  const [logo, mark, favicon] = await Promise.all([
    readFile(join(assetRoot, "bettertunnels-horizontal-light.svg"), "utf8"),
    readFile(join(assetRoot, "bettertunnels-square-dark-1024x1024.png")),
    readFile(join(assetRoot, "favicon.svg"), "utf8")
  ]);

  cached = {
    logoUrl: svgDataUrl(logo),
    markUrl: `data:image/png;base64,${mark.toString("base64")}`,
    faviconUrl: svgDataUrl(favicon)
  };

  return cached;
}

function svgDataUrl(value: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(value).toString("base64")}`;
}
