const fs = require("fs");

const bundle = fs.readFileSync("vendor/cloudbase.bundle.js", "utf8");
const installedVersion = require("../node_modules/@cloudbase/js-sdk/package.json").version;
const checks = [
  [installedVersion === "3.8.2", `expected @cloudbase/js-sdk 3.8.2, got ${installedVersion}`],
  [bundle.includes("globalThis.cloudbase"), "globalThis.cloudbase assignment is missing"],
  [bundle.includes("/v1/storages"), "CloudBase PG Storage module is missing"],
  [bundle.includes("CloudBase SDK ready"), "SDK readiness marker is missing"],
  [!bundle.includes("/undefined"), "bundle contains /undefined"],
  [!bundle.includes("klementhro.github.io"), "bundle contains a hard-coded GitHub Pages URL"]
];

for (const [passed, message] of checks) {
  if (!passed) throw new Error(message);
}

console.log(`CloudBase bundle check passed (${Buffer.byteLength(bundle)} bytes)`);
