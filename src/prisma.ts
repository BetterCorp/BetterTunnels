import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/index.js";

let prismaClient: PrismaClient | undefined;
let configuredConnectionString: string | undefined;

export function configurePrisma(connectionString: string): PrismaClient {
  if (!connectionString) {
    throw new Error("Prisma connection string is required");
  }
  if (prismaClient) {
    if (configuredConnectionString !== connectionString) {
      throw new Error("Prisma has already been configured with a different connection string");
    }
    return prismaClient;
  }

  configuredConnectionString = connectionString;
  prismaClient = new PrismaClient({
    adapter: new PrismaPg({ connectionString })
  });
  return prismaClient;
}

export function getPrisma(): PrismaClient {
  if (!prismaClient) {
    throw new Error("Prisma is not configured. Configure it from BSB service config before use.");
  }
  return prismaClient;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getPrisma() as unknown as Record<PropertyKey, unknown>;
    const value = client[property];
    return typeof value === "function" ? value.bind(client) : value;
  }
});
