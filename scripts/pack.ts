import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
  "public/fonts",
];

export function isExcluded(name: string): boolean {
  return name === ".DS_Store" || (name.startsWith(".env") && name !== ".env.example");
}

/** Stages PACK_INCLUDE (no symlinks, no env files) under <tmp>/atlassian-notes and zips that folder. */
export function buildZip(root: string, out: string): void {
  const stage = mkdtempSync(join(tmpdir(), "atlassian-notes-pack-"));
  try {
    const dest = join(stage, "atlassian-notes");
    for (const entry of PACK_INCLUDE) {
      mkdirSync(dirname(join(dest, entry)), { recursive: true });
      cpSync(join(root, entry), join(dest, entry), {
        recursive: true,
        filter: (src) => !isExcluded(basename(src)) && !lstatSync(src).isSymbolicLink(),
      });
    }
    rmSync(out, { force: true });
    const res = spawnSync("zip", ["-r", "-q", "-y", out, "atlassian-notes", "-x", "*.DS_Store"], {
      cwd: stage,
      stdio: "inherit",
    });
    if (res.status !== 0) throw new Error("zip failed.");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(dirname(root), "atlassian-notes.zip");

  const missing = PACK_INCLUDE.filter((e) => !existsSync(join(root, e)));
  if (missing.length) {
    console.error(`Cannot pack, missing: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (spawnSync("zip", ["-v"], { stdio: "ignore" }).error) {
    console.error("The `zip` command was not found. Install it (macOS and most Linux distros ship it) and try again.");
    process.exit(1);
  }
  try {
    buildZip(root, out);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  console.log(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
