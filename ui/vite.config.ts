import { defineConfig } from "vite";

// The UI imports the shared engine modules (../engine/src) so the ABI, reason codes and trade helpers exist once.
export default defineConfig({
  server: { fs: { allow: [".."] }, port: 5173 },
  resolve: { dedupe: ["viem"] },
  // two pages: the trading UI (index.html) and the 7D replay demo (replay.html, R §8)
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", replay: "replay.html" } } },
});
