import {
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas
} from "@bsb/base";
import * as av from "anyvali";
import type { ConfigSchemaDescriptor } from "@betterportal/framework";
import { BetterPortalConfigSchema, BPService, type BPServiceDefinition } from "@betterportal/plugin-bsb";
import { registry } from "./.bp-generated/registry.js";

const PluginConfigSchema = av.object({
  host: av.string().minLength(1).default("0.0.0.0"),
  port: av.int().min(1).default(8083),
  betterportal: BetterPortalConfigSchema
}, { unknownKeys: "strip" });

const Config = createConfigSchema(
  {
    name: "service-betterportal",
    description: "BetterPortal public and management UI for BetterTunnels",
    image: "./betterportal-logo.png",
    tags: ["betterportal", "web", "management", "tunnels"]
  },
  PluginConfigSchema
);

const EventSchemas = createEventSchemas({
  emitEvents: {},
  onEvents: {},
  emitReturnableEvents: {},
  onReturnableEvents: {},
  emitBroadcast: {},
  onBroadcast: {}
});

const ConfigSchemas: ConfigSchemaDescriptor[] = [
  {
    id: "better-tunnels.tenant",
    title: "BetterTunnels",
    description: "Tenant-level BetterTunnels settings.",
    scope: "tenant",
    jsonSchema: {
      type: "object",
      properties: {
        mainAuthAppPublicUrl: { type: "string" },
        mainAuthAppId: { type: "string" }
      },
      required: ["mainAuthAppPublicUrl"]
    },
    groups: [
      {
        id: "cli-auth",
        title: "CLI authentication",
        description: "The BetterPortal app used for BetterTunnels CLI login.",
        order: 10
      }
    ],
    fields: [
      {
        key: "mainAuthAppPublicUrl",
        title: "Main auth app public URL",
        description: "Public BetterPortal app URL used to start CLI authentication.",
        scope: "tenant",
        visibility: "protected",
        ownership: "bp",
        sourceOfTruth: "bp",
        groupId: "cli-auth",
        order: 10,
        required: true,
        ui: {
          control: "url",
          placeholder: "https://betterportal.cloud"
        }
      },
      {
        key: "mainAuthAppId",
        title: "Main auth app id",
        description: "Optional BetterPortal app id to enforce on CLI verification.",
        scope: "tenant",
        visibility: "protected",
        ownership: "bp",
        sourceOfTruth: "bp",
        groupId: "cli-auth",
        order: 20,
        required: false,
        ui: {
          control: "text",
          placeholder: "app id"
        }
      }
    ]
  }
];

export class Plugin extends BPService<InstanceType<typeof Config>, typeof EventSchemas> {
  static Config = Config;
  static EventSchemas = EventSchemas;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super({ ...cfg, eventSchemas: EventSchemas });
  }

  protected definition(): BPServiceDefinition {
    return {
      manifest: {
        pluginId: "service.betterportal.tunnels",
        title: "BetterTunnels",
        description: "Public site and management surface for BetterTunnels.",
        category: "service",
        capabilities: [
          "tunnels.public-landing",
          "tunnels.management",
          "tunnels.observability",
          "tunnels.client-auth"
        ],
        configSchemas: ConfigSchemas
      },
      registry
    };
  }
}

export { Config, EventSchemas };
