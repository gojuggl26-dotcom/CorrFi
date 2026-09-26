// Operator funding (S08): RPC_URL, FROM_KEY (the paying account, from the environment only); DEPLOYMENT for tUSDC.
//   node bin/fund.ts eth <address> <ether> [<address> <ether> ...]   send ETH for gas (before the deployment exists)
//   node bin/fund.ts tusdc <address> <amount>                         mint the test token (DEC-13; owner only: FROM_KEY = the deployer)
import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { testUsdcAbi } from "../src/abi.ts";
import { loadDeployment } from "../src/chain.ts";
import { env } from "./common.ts";

const rpc = env("RPC_URL");
const probe = createPublicClient({ transport: http(rpc) });
const chain = defineChain({ id: await probe.getChainId(), name: "chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const pc = createPublicClient({ chain, transport: http(rpc) });
const w = createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(env("FROM_KEY") as Hex) });
const [cmd, ...a] = process.argv.slice(2);

async function done(hash: Hex, what: string) {
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(JSON.stringify({ what, tx: hash, status: r.status, block: Number(r.blockNumber) }));
  if (r.status !== "success") process.exitCode = 1;
}

if (cmd === "eth") {
  for (let i = 0; i + 1 < a.length; i += 2) {
    await done(await w.sendTransaction({ to: a[i] as Address, value: parseEther(a[i + 1]) }), `${a[i + 1]} ETH -> ${a[i]}`);
  }
} else if (cmd === "tusdc") {
  const dep = loadDeployment(env("DEPLOYMENT"));
  const { request } = await pc.simulateContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "mint", args: [a[0] as Address, parseUnits(a[1], 6)], account: w.account });
  await done(await w.writeContract(request), `${a[1]} tUSDC -> ${a[0]}`);
} else {
  console.error("usage: fund.ts eth <address> <ether> ... | tusdc <address> <amount>");
  process.exitCode = 2;
}
