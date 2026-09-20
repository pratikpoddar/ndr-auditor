import { vitePlugin as remix } from "@remix-run/dev";
import { installGlobals } from "@remix-run/node";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

installGlobals({ nativeFetch: true });

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

export default defineConfig({
  server: {
    allowedHosts: true,
    port: Number(process.env.PORT || 3000),
    hmr: process.env.SHOPIFY_APP_URL
      ? { protocol: "wss", host: new URL(process.env.SHOPIFY_APP_URL).hostname, clientPort: 443 }
      : undefined,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
        v3_routeConfig: false,
      },
    }),
    tsconfigPaths(),
  ],
  build: { assetsInlineLimit: 0 },
}) satisfies UserConfig;
