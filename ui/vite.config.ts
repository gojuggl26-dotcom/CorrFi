import { defineConfig } from "vite";

// The public site (GitHub Pages, CORRFI_SITE=public) leaves out the 7D replay page: it needs the local driver and verifier.
const publicSite = process.env.CORRFI_SITE === "public";

// The UI imports the shared engine modules (../engine/src) so the ABI, reason codes and trade helpers exist once.
export default defineConfig({
  base: "./", // relative URLs: the site works under any path (GitHub Pages serves it at /CorrFi/)
  server: { fs: { allow: [".."] }, port: 5173 },
  resolve: { dedupe: ["viem"] },
  // pages: home (index.html), trading (trade.html), the tUSDC faucet (faucet.html), redemption (redeem.html), the maker's
  // funds (maker.html) and, except on the public site, the 7D replay demo (replay.html, R §8)
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: "index.html",
        trade: "trade.html",
        faucet: "faucet.html",
        redeem: "redeem.html",
        maker: "maker.html",
        ...(publicSite ? {} : { replay: "replay.html" }),
      },
    },
  },
});
