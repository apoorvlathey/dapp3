// Vite's __vitePreload helper touches `document` (to inject <link rel=modulepreload>)
// and `window` (to dispatch a "vite:preloadError" event when a dynamic import
// rejects). Neither exists in an MV3 service worker, so any dynamic import that
// rejects — e.g. viem's `await import('../utils/ccip.js')` inside its eth_call
// catch block — surfaces as a confusing ReferenceError that masks the real
// cause. Shim just enough so the helper runs without throwing; the original
// error is then re-thrown by the helper as intended.
const g = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
};
if (typeof g.window === "undefined") {
  g.window = globalThis;
}
const w = g.window as { dispatchEvent?: (e: unknown) => boolean };
if (typeof w.dispatchEvent !== "function") {
  w.dispatchEvent = () => true;
}
if (typeof g.document === "undefined") {
  g.document = {
    getElementsByTagName: () => [],
    querySelector: () => null,
    head: { appendChild: () => undefined },
    createElement: () => ({
      addEventListener: () => undefined,
      setAttribute: () => undefined,
    }),
  };
}
