import * as av from "anyvali";
import type { Infer } from "anyvali";
import { createHandler } from "@betterportal/framework";
import { loadBrandAssets } from "../../brand-assets.js";

const DownloadSchema = av.object({
  os: av.string(),
  arch: av.string(),
  artifact: av.string()
}, { unknownKeys: "strip" });

export const ResponseSchema = av.object({
  latestTag: av.string(),
  logoUrl: av.string(),
  examples: av.array(av.string()),
  downloads: av.array(DownloadSchema)
}, { unknownKeys: "strip" });
export type ResponseData = Infer<typeof ResponseSchema>;

export default createHandler(
  { response: ResponseSchema },
  async () => {
    const brand = await loadBrandAssets();

    return {
      latestTag: "v0.1.0",
      logoUrl: brand.logoUrl,
      examples: [
        "better-tunnels tunnel --port 3100",
        "better-tunnels tunnel --host 127.0.0.1 --port 3100",
        "better-tunnels tunnel --config .bettertunnel"
      ],
      downloads: [
        { os: "Windows", arch: "amd64", artifact: "better-tunnels-windows-amd64.exe" },
        { os: "Linux", arch: "amd64", artifact: "better-tunnels-linux-amd64" },
        { os: "Linux", arch: "arm64", artifact: "better-tunnels-linux-arm64" },
        { os: "macOS", arch: "amd64", artifact: "better-tunnels-darwin-amd64" },
        { os: "macOS", arch: "arm64", artifact: "better-tunnels-darwin-arm64" }
      ]
    };
  }
);
