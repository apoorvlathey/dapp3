import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "dapp3.eth",
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
    default_popup: "popup.html",
    default_title: "dapp3.eth",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  options_page: "options.html",
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
    // Required so the declarativeNetRequest redirect rule can intercept
    // `*.eth` main_frame requests *before* Chrome's DNS probe shows the
    // "site can't be reached" page. DNR redirects need host access to the
    // target URL; without this, the rule silently no-ops.
    "*://*.eth/*",
    // Same reason for the optional `*.eth.limo` / `*.eth.link` interception
    // (toggle in settings). The DNR rule rewrites `<x>.eth.limo` /
    // `<x>.eth.link` → `<x>.eth`; without host access to the request URL the
    // redirect is a silent no-op.
    "*://*.eth.limo/*",
    "*://*.eth.link/*",
    // Same reason for the optional `0x<addr>.w3eth.io` interception. The DNR
    // rule rewrites those URLs into the interstitial with the contract address
    // stashed in the fragment; without host access the redirect is a silent
    // no-op and the public w3eth.io gateway wins the request.
    "*://*.w3eth.io/*",
  ],
  optional_host_permissions: ["https://*/*", "http://*/*"],
  content_security_policy: {
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-ancestors 'none'",
  },
  web_accessible_resources: [
    {
      resources: [
        "error.html",
        "interstitial.html",
        "offscreen.html",
        "onboarding.html",
        "bookmarks.html",
        "home.html",
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
