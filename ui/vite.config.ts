import { defineConfig } from "vite";

// The UI imports the shared engine modules (../engine/src) so the ABI, reason codes and trade helpers exist once.
export default defineConfig({
  server: { fs: { allow: [".."] }, port: 5173 },
  resolve: { dedupe: ["viem"] },
  build: { target: "es2022" },
});
