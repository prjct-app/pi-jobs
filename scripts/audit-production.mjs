import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function runtimeManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || typeof manifest.name !== "string") {
    throw new Error("Expected a named npm package manifest");
  }
  const result = { name: "pi-runtime-security-audit", private: true };
  for (const field of ["dependencies", "optionalDependencies"]) {
    const values = manifest[field];
    if (values === undefined) continue;
    if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.values(values).some(value => typeof value !== "string")) {
      throw new Error(`Invalid ${field}`);
    }
    result[field] = values;
  }
  return result;
}

export function auditProduction(packageRoot = process.cwd()) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const temporary = mkdtempSync(join(tmpdir(), "pi-runtime-security-"));
  try {
    writeFileSync(join(temporary, "package.json"), JSON.stringify(runtimeManifest(manifest), null, 2));
    console.log(`Auditing ${manifest.name}: normal runtime dependencies, with Pi-provided peers and development tooling excluded.`);
    for (const args of [
      ["install", "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"],
      ["audit", "--omit=dev"],
    ]) {
      const result = spawnSync("npm", args, { cwd: temporary, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = auditProduction(process.argv[2]);
}
