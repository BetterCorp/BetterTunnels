import {
  type BSBServiceConstructor,
  createConfigSchema,
  createEventSchemas
} from "@bsb/base";
import * as av from "anyvali";
import { BetterPortalConfigSchema, BPService, type BPServiceDefinition } from "@betterportal/plugin-bsb";
import { registry } from "./.bp-generated/registry.js";

const PluginConfigSchema = av.object({
  host: av.string().minLength(1).default("0.0.0.0"),
  port: av.int().min(1).default(8082),
  betterportal: BetterPortalConfigSchema
}, { unknownKeys: "strip" });

const Config = createConfigSchema(
  {
    name: "service-betterportal-bettertunnels",
    description: "BetterPortal management surface for BetterTunnels",
    tags: ["betterportal", "management", "tunnels"]
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

export class Plugin extends BPService<InstanceType<typeof Config>, typeof EventSchemas> {
  static Config = Config;
  static EventSchemas = EventSchemas;

  constructor(cfg: BSBServiceConstructor<InstanceType<typeof Config>, typeof EventSchemas>) {
    super({ ...cfg, eventSchemas: EventSchemas });
  }

  protected definition(): BPServiceDefinition {
    return {
      manifest: {
        pluginId: "service.betterportal.bettertunnels",
        title: "BetterTunnels",
        description: "Manage BetterTunnels sessions and tunnel health from BetterPortal.",
        category: "service",
        capabilities: ["tunnels.management", "tunnels.observability"]
      },
      registry
    };
  }
}

export { Config, EventSchemas };
