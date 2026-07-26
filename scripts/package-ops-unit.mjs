import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { buildPackageScriptArgv } from "../dist/packageOps.js";
import { buildVitestArgv } from "../dist/testOps.js";

const config = loadConfig(["--root", process.cwd()]);
const settings = config.packageScriptTools;

// 1. pnpm filter command argv is correct
{
  const built = buildPackageScriptArgv(
    { packageManager: "pnpm", filter: "@zside/frontend", script: "typecheck" },
    settings
  );
  assert.equal(built.command, "pnpm");
  assert.deepEqual(built.args, ["--filter", "@zside/frontend", "typecheck"]);
  assert.equal(built.display, "pnpm --filter @zside/frontend typecheck");
}

// 2. vitest isolated file command is correct
{
  const built = buildVitestArgv({
    packageFilter: "@zside/frontend",
    files: ["src/pages/Tools/__tests__/Tools.test.tsx"]
  });
  assert.equal(built.command, "pnpm");
  assert.deepEqual(built.args, [
    "--filter",
    "@zside/frontend",
    "exec",
    "vitest",
    "run",
    "src/pages/Tools/__tests__/Tools.test.tsx"
  ]);
}

// 3. Rejects unknown package manager
assert.throws(
  () => buildPackageScriptArgv({ packageManager: "bun", script: "test" }, settings),
  /not allowed|Package manager/i
);

// 4. Rejects args with null bytes
assert.throws(
  () => buildPackageScriptArgv({ packageManager: "pnpm", script: "test", args: ["ok\0bad"] }, settings),
  /null byte/i
);

// 5. npm run path
{
  const built = buildPackageScriptArgv({ packageManager: "npm", script: "build", args: ["--", "--mode", "prod"] }, settings);
  assert.deepEqual(built.args, ["run", "build", "--", "--mode", "prod"]);
}

// 6. Reject shell metacharacters in vitest files
assert.throws(
  () => buildVitestArgv({ files: ["foo; rm -rf /"] }),
  /Unsafe|Invalid/i
);

console.log("package-ops-unit: ok");
