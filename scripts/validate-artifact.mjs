import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, "roboboy.panel.json"), "utf8"),
);
const bundlePath = resolve(projectRoot, manifest.entryPoint);
const bundle = await readFile(bundlePath);
const integrity = `sha256-${createHash("sha256").update(bundle).digest("base64")}`;
const module = await import(
  `${pathToFileURL(bundlePath).href}?validate=${Date.now()}`
);

if (
  manifest.schemaVersion !== 1 ||
  !manifest.id ||
  !manifest.version ||
  !manifest.entryPoint ||
  !manifest.integrity
) {
  throw new Error("roboboy.panel.json is missing required metadata.");
}
if (integrity !== manifest.integrity) {
  throw new Error(
    `Bundle integrity mismatch: expected ${manifest.integrity}, received ${integrity}.`,
  );
}
if (
  !module.default ||
  module.default.id !== manifest.id ||
  module.default.apiVersion !== "2.0.0"
) {
  throw new Error("The built module does not match roboboy.panel.json.");
}
if (typeof module.default.activate !== "function") {
  throw new Error("The built module must export an activate function.");
}

const noop = () => {};
const instance = await module.default.activate({
  panelId: manifest.id,
  instanceId: "artifact-validation",
  capabilities: manifest.capabilities,
  ros: {
    getTopics: async () => [],
    selectTopic: async () => {
      throw new Error("Not expected during artifact activation.");
    },
    subscribe: async () => {
      throw new Error("Not expected during artifact activation.");
    },
    publish: async () => {},
    callService: async () => {
      throw new Error("Not expected during artifact activation.");
    },
  },
  storage: null,
  network: {
    endpoints: {
      webrtcWhep: "https://roboboy.example/webrtc/",
      webrtcDiscovery: "https://roboboy.example/webrtc/_discovery/paths",
      webrtcHls: "https://roboboy.example:8888/",
    },
    fetch: async () => {
      throw new Error("Network access is not expected during artifact activation.");
    },
  },
  runtime: {
    target: "web",
  },
  connection: {
    getSnapshot: () => ({ status: "disconnected", generation: 0 }),
    subscribe: () => noop,
  },
  viewport: {
    getSnapshot: () => ({
      width: 800,
      height: 500,
      isIntersecting: true,
      isDocumentVisible: true,
      isActive: true,
    }),
    subscribe: () => noop,
    requestFullscreen: async () => {},
  },
  theme: {
    getSnapshot: () => ({ colorScheme: "dark", tokens: {} }),
    subscribe: () => noop,
  },
  logger: { debug: noop, info: noop, warn: noop, error: noop },
});
if (
  typeof instance?.mount !== "function" ||
  typeof instance?.unmount !== "function"
) {
  throw new Error(
    "The panel instance must provide mount and unmount functions.",
  );
}

console.log(
  `Validated ${manifest.id}@${manifest.version} (${bundle.byteLength} bytes)`,
);
