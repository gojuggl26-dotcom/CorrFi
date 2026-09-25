// CorrFi SwapVM orders (M §5.1): the byte layout of MakerTraitsLib.build (lib/swap-vm feb1641,
// contracts/libs/MakerTraits.sol) for the one shape the router registers — Aqua mode, hooks preTransferOut and
// postTransferIn targeting the router, receiver = maker, program Deadline(obsEnd) -> CorrReport -> CorrCurve ->
// CorrGuard. The router re-checks every field at registration, and its hash() must equal orderHash() here.

import { type Address, concat, encodeAbiParameters, type Hex, keccak256, numberToHex, pad } from "viem";

// MakerTraits bit flags (MakerTraits.sol)
export const USE_AQUA = 1n << 254n;
export const HAS_POST_TRANSFER_IN_HOOK = 1n << 251n;
export const HAS_PRE_TRANSFER_OUT_HOOK = 1n << 250n;
export const POST_TRANSFER_IN_HOOK_HAS_TARGET = 1n << 247n;
export const PRE_TRANSFER_OUT_HOOK_HAS_TARGET = 1n << 246n;
const ORDER_DATA_SLICES_INDEXES_BIT_OFFSET = 160n;

export const SIDE_LONG = 0;
export const SIDE_SHORT = 1;

export interface Order {
  maker: Address;
  traits: bigint;
  data: Hex;
}

const u8 = (x: number) => pad(numberToHex(x), { size: 1 });

/** Deadline(obsEnd) -> CorrReport(m, side, generation) -> CorrCurve -> CorrGuard: `0x20 05 obsEnd(5) | 0xd0 06 ...`. */
export function canonicalProgram(obsEnd: number, marketId: number, side: number, generation: number): Hex {
  return concat([
    "0x2005",
    pad(numberToHex(obsEnd), { size: 5 }),
    "0xd006",
    u8(marketId),
    u8(side),
    pad(numberToHex(generation), { size: 4 }),
    "0xd100d200",
  ]);
}

export interface OrderSpec {
  maker: Address;
  usdc: Address;
  sideToken: Address;
  router: Address;
  obsEnd: number;
  marketId: number;
  side: number;
  generation: number;
}

export function buildOrder(s: OrderSpec): Order {
  const [tokenA, tokenB] = BigInt(s.usdc) < BigInt(s.sideToken) ? [s.usdc, s.sideToken] : [s.sideToken, s.usdc];
  // data slices: [tokens 40][postTransferIn target 20][preTransferOut target 20][program]
  const index0 = 40n; // end of preTransferIn (absent)
  const index1 = 60n; // end of postTransferIn (router)
  const index2 = 80n; // end of preTransferOut (router)
  const index3 = 80n; // end of postTransferOut (absent)
  const indexes = (index3 << 48n) | (index2 << 32n) | (index1 << 16n) | index0;
  const traits =
    USE_AQUA |
    HAS_POST_TRANSFER_IN_HOOK |
    HAS_PRE_TRANSFER_OUT_HOOK |
    POST_TRANSFER_IN_HOOK_HAS_TARGET |
    PRE_TRANSFER_OUT_HOOK_HAS_TARGET |
    (indexes << ORDER_DATA_SLICES_INDEXES_BIT_OFFSET);
  const data = concat([tokenA, tokenB, s.router, s.router, canonicalProgram(s.obsEnd, s.marketId, s.side, s.generation)]);
  return { maker: s.maker, traits, data };
}

const ORDER_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "maker", type: "address" },
      { name: "traits", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

/** SwapVM.hash for Aqua-mode orders = keccak256(abi.encode(order)) = the Aqua strategy hash of the shipped bytes. */
export const orderStrategy = (o: Order): Hex => encodeAbiParameters(ORDER_TUPLE, [o]);
export const orderHash = (o: Order): Hex => keccak256(orderStrategy(o));
