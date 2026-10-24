import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PACK_INCLUDE: string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.web.json",
  ".env.example",
  "README.md",
  "examples",
  "scripts",
  "src",
  "public/index.html",
];

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(dirname(root), "atlassian-notes.zip");

  const missing = PACK_INCLUDE.filter((e) => !existsSync(join(root, e)));
  if (missing.length) {
    console.error(`Cannot pack, missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  const probe = spawnSync("zip", ["-v"], { stdio: "ignore" });
  if (probe.error) {
    console.error("The `zip` command was not found. Install it (macOS and most Linux distros ship it) and try again.");
    process.exit(1);
  }
  rmSync(out, { force: true });
  const res = spawnSync("zip", ["-r", "-q", out, ...PACK_INCLUDE, "-x", "*.DS_Store"], {
    cwd: root,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error("zip failed.");
    process.exit(res.status ?? 1);
  }
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
