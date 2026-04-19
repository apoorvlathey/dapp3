import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "local-eth-limo",
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: "116",
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  action: {
    default_popup: "src/popup/popup.html",
    default_title: "local-eth-limo",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  options_page: "src/options/options.html",
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["http://*.ipfs.localhost/*", "http://*.ipns.localhost/*"],
      js: ["src/content/banner.ts"],
      run_at: "document_start",
      all_frames: false,
    },
  ],
  permissions: [
    "webNavigation",
    "tabs",
    "storage",
    "offscreen",
    "declarativeNetRequest",
  ],
  host_permissions: [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "http://*.localhost/*",
  ],
  optional_host_permissions: ["https://*/*", "http://*/*"],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  web_accessible_resources: [
    {
      resources: [
        "src/error/error.html",
        "src/interstitial/interstitial.html",
        "src/offscreen/offscreen.html",
        "src/onboarding/onboarding.html",
      ],
      matches: ["<all_urls>"],
    },
  ],
  declarative_net_request: {
    rule_resources: [
      {
        id: "no_https_upgrade",
        enabled: true,
        path: "rules/no_https_upgrade.json",
      },
    ],
  },
});
