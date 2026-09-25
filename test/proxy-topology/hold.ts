// Helper process for the kill -9 test: brings the topology up, announces the run id, then idles until it is killed.
// Usage: node hold.js <docker|podman>
import { Credential } from "../../src/sandbox/registry-proxy/index.js";
import { buildProxyConfig, withProxyTopology } from "../../src/sandbox/proxy-topology/index.js";

const runtime = process.argv[2] === "docker" ? "docker" : "podman";
const config = buildProxyConfig({
  registries: [{ id: "main", upstream: "https://registry.example.com", credential: new Credential("bearer", "CANARY-tok-9f3a7c21d4b85e60aa17") }],
  dns: ["1.1.1.1"],
});
await withProxyTopology({ settings: { runtime, image: "node:24", rootless: runtime === "podman" }, config }, async (t) => {
  process.stdout.write(`UP ${t.runId}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10 * 60 * 1000));
});
