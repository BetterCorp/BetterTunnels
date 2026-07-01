import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const source = join(root, "src", "generated", "prisma");
const target = join(root, "lib", "generated", "prisma");

if (!existsSync(source)) {
  throw new Error("Prisma generated client is missing. Run npm run prisma:generate first.");
}

mkdirSync(dirname(target), { recursive: true });
cpSync(source, target, { recursive: true });
