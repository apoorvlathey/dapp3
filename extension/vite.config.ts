import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "esnext",
    sourcemap: true,
    // Vite's __vitePreload helper injects <link rel="modulepreload"> via
    // document.head, which throws "document is not defined" inside the MV3
    // service worker. Viem's call.js catch-block does `await import('ccip')`
    // after every failed eth_call, so without this flag any Helios-side
    // eth_call failure surfaces as "document is not defined" instead of the
    // real reason.
    modulePreload: false,
    rollupOptions: {
      input: {
        error: "error.html",
        interstitial: "interstitial.html",
        offscreen: "offscreen.html",
        onboarding: "onboarding.html",
        bookmarks: "bookmarks.html",
        home: "home.html",
      },
      output: {
        chunkFileNames: "assets/chunk-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
