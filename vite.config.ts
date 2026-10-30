import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiOrigin, forwardedOrigin } from "./scripts/dev-proxy";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (outgoing, incoming) => {
            const origin = forwardedOrigin(
              incoming.headers.origin,
              incoming.headers.host,
            );
            if (origin !== undefined) outgoing.setHeader("Origin", origin);
          });
        },
      },
    },
  },
});
