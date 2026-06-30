import type { Observable } from "@bsb/base";
import type { WebSocket } from "ws";

export interface ActiveTunnel {
  id: string;
  subdomain: string;
  targetHost: string;
  targetPort: number;
  authenticated: boolean;
  expiresAt: Date;
  ws: WebSocket;
  pending: Map<string, PendingRequest>;
  sessionObs: Observable;
}

export interface PendingRequest {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  chunks: string[];
  status?: number;
  headers?: Record<string, string>;
  webStartedAt: number;
  clientApiSentAt: number;
  clientApiRoundtripMs?: number;
  cliOverheadMs?: number;
  originMs?: number;
  totalTimer: NodeJS.Timeout;
  firstByteTimer: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  idleTimeoutMs: number;
}

export class TunnelRegistry {
  private readonly tunnels = new Map<string, ActiveTunnel>();

  set(tunnel: ActiveTunnel): void {
    this.tunnels.set(tunnel.subdomain, tunnel);
  }

  get(hostname: string): ActiveTunnel | undefined {
    const subdomain = hostname.split(".")[0] ?? "";
    return this.tunnels.get(subdomain);
  }

  delete(subdomain: string): void {
    this.tunnels.delete(subdomain);
  }
}
