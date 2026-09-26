import { defineConfig } from "vite";

// The UI imports the shared engine modules (../engine/src) so the ABI, reason codes and trade helpers exist once.
export default defineConfig({
  server: { fs: { allow: [".."] }, port: 5173 },
  resolve: { dedupe: ["viem"] },
  // five pages: home (index.html), trading (trade.html), the tUSDC faucet (faucet.html), redemption (redeem.html) and the 7D replay demo (replay.html, R §8)
  build: { target: "es2022", rollupOptions: { input: { main: "index.html", trade: "trade.html", faucet: "faucet.html", redeem: "redeem.html", replay: "replay.html" } } },
});
