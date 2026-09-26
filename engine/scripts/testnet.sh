#!/usr/bin/env bash
# S08 operations (M §8.2.2) on Base Sepolia, or on a local Anvil for a rehearsal. Keys come from ENV_FILE, which lives
# outside the repository and is never printed (DEC-25). Every step can be re-run; outputs go to deployments/ (public
# data only) and to WORK_DIR (default ~/.corrfi/<name>).
#
#   ENV_FILE=~/.corrfi/basesepolia.env DEPLOY_NAME=base-sepolia engine/scripts/testnet.sh <step> [args]
#
#   balances            ETH of the roles (and tUSDC once deployed)
#   fund                deployer -> reporter / maker / taker ETH (FUND_REPORTER, FUND_MAKER, FUND_TAKER in ether)
#   deploy              contracts/script/Deploy.s.sol with --broadcast; keeps the broadcast in deployments/
#   verify              V7: creation bytecode of every deployment tx and runtime bytecode on the chain vs the manifest
#   calib               fetch this month's 1-minute bars, then calib_{7,14,28}.json with cutoff = the next obsStart
#   markets             create the 7D / 14D / 28D markets inside the cutoff's 5-minute window (DEC-27)
#   maker               mint tUSDC to the maker (as the deployer), set the M §8.1 settings, open both books of every market
#   bots                start the reporter + finalizer supervisor in the background (DEC-26)
#   e2e <market>        4 directions x inventory paths with quote = swap checks (bin/e2e.ts trades)
#   status <market>     trading state now (bin/e2e.ts status)
#   stats               reporter latency and stop time (bin/reporter-stats.ts)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${ENV_FILE:?set ENV_FILE to the keys file}"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export PATH="$HOME/.foundry/bin:$PATH"
NAME="${DEPLOY_NAME:-base-sepolia}"
export DEPLOYMENT="$ROOT/deployments/$NAME.json"
export OWNER_KEY="$DEPLOYER_KEY" ENGINE_KEY="$PRICE_SIGNER_KEY"
WORK="${WORK_DIR:-$HOME/.corrfi/$NAME}"
mkdir -p "$WORK"
step="${1:?step}"
shift || true
eng() { (cd "$ROOT/engine" && "$@"); }

case "$step" in
balances)
  for r in DEPLOYER REPORTER MAKER TAKER; do
    a="${r}_ADDRESS"
    echo "$r ${!a} $(cast balance "${!a}" --rpc-url "$RPC_URL" --ether) ETH"
  done
  ;;
fund)
  FROM_KEY="$DEPLOYER_KEY" eng node bin/fund.ts eth "$REPORTER_ADDRESS" "${FUND_REPORTER:-0.05}" \
    "$MAKER_ADDRESS" "${FUND_MAKER:-0.01}" "$TAKER_ADDRESS" "${FUND_TAKER:-0.01}"
  ;;
deploy)
  cid="$(cast chain-id --rpc-url "$RPC_URL")"
  # Before sending anything: a full rebuild must equal the pinned manifest, and so must the creation code of a
  # simulated run. via-IR output can depend on which files an incremental build compiles together (2026-09-26: a
  # script build differed from out/ by 52 bytes), and a deployed mismatch could only be fixed by redeploying.
  (cd "$ROOT/contracts" && forge build --force)
  eng node scripts/build_manifest.ts --check
  (cd "$ROOT/contracts" && REPORTER="$REPORTER_ADDRESS" PRICE_SIGNER="$PRICE_SIGNER_ADDRESS" TREASURY="$DEPLOYER_ADDRESS" \
    DEPLOY_NAME="$NAME-dryrun" forge script script/Deploy.s.sol --rpc-url "$RPC_URL" ${FORGE_ARGS:-})
  rm -f "$ROOT/deployments/$NAME-dryrun.json"
  eng node scripts/build_manifest.ts --broadcast "$ROOT/contracts/broadcast/Deploy.s.sol/$cid/dry-run/run-latest.json"
  (cd "$ROOT/contracts" && REPORTER="$REPORTER_ADDRESS" PRICE_SIGNER="$PRICE_SIGNER_ADDRESS" TREASURY="$DEPLOYER_ADDRESS" \
    DEPLOY_NAME="$NAME" forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow ${FORGE_ARGS:-})
  cp "$ROOT/contracts/broadcast/Deploy.s.sol/$cid/run-latest.json" "$ROOT/deployments/$NAME.broadcast.json"
  cat "$DEPLOYMENT"
  ;;
verify)
  eng node scripts/build_manifest.ts --broadcast "$ROOT/deployments/$NAME.broadcast.json"
  eng node scripts/build_manifest.ts --deployed "$DEPLOYMENT"
  ;;
calib)
  # the whole month: fetch_klines rewrites a month file with the fetched window
  month="$(date -u +%Y-%m-01)"
  (cd "$ROOT" && python data/fetch_klines.py --start "$month" --end "$(date -u +%Y-%m-%dT%H:%MZ)")
  # cutoff = the obsStart of markets created in the 5 minutes before it; about 60 s of calibration fits the lead
  now="$(date -u +%s)"
  cutoff="$(( (now + ${LEAD_SEC:-240} + 299) / 300 * 300 ))"
  iso="$(date -u -d @"$cutoff" +%Y-%m-%dT%H:%MZ)"
  for T in 7 14 28; do
    (cd "$ROOT" && python data/make_calib.py --cutoff "$iso" --tenor "$T" --out "$WORK/calib_$T.json")
  done
  echo "$cutoff" > "$WORK/cutoff"
  echo "cutoff $iso ($cutoff): markets must be created in ($((cutoff - 300)), $cutoff]"
  ;;
markets)
  cutoff="$(cat "$WORK/cutoff")"
  while :; do
    t="$(cast block latest -f timestamp --rpc-url "$RPC_URL")"
    [ "$t" -gt "$((cutoff - 30))" ] && { echo "too close to the cutoff: rerun calib"; exit 1; }
    [ "$t" -gt "$((cutoff - 290))" ] && break
    sleep 5
  done
  for T in 7 14 28; do
    eng node bin/create-market.ts "$WORK/calib_$T.json" | tee -a "$WORK/markets.jsonl"
  done
  ;;
maker)
  # tUSDC mint is owner-only (the deployer); the maker gets 1,000,000 (user decision 2026-09-26)
  FROM_KEY="$DEPLOYER_KEY" eng node bin/fund.ts tusdc "$MAKER_ADDRESS" "${MAKER_TUSDC:-1000000}"
  eng node bin/maker.ts config
  hub="$(node -p "require(process.argv[1]).hub" "$(cygpath -w "$DEPLOYMENT" 2>/dev/null || echo "$DEPLOYMENT")")"
  n="$(cast call "$hub" 'marketCount()(uint8)' --rpc-url "$RPC_URL")"
  for m in $(seq 0 $((n - 1))); do
    eng node bin/maker.ts open "$m" 1 "${ALLOCATION:-55000}" "${APPROVAL:-105000}"
  done
  ;;
bots)
  mkdir -p "$WORK/logs"
  (cd "$ROOT/engine" && ENV_FILE="$ENV_FILE" DEPLOYMENT="$DEPLOYMENT" LOG_DIR="$WORK/logs" \
    nohup node bin/supervise.ts > "$WORK/logs/supervise.out" 2>&1 &
   echo "supervisor pid $!")
  ;;
e2e)
  E2E_OUT="$ROOT/deployments/$NAME-e2e.jsonl" eng node bin/e2e.ts trades "${1:-0}" "${2:-1}"
  ;;
status)
  E2E_OUT="$ROOT/deployments/$NAME-e2e.jsonl" eng node bin/e2e.ts status "${1:-0}" "${2:-1}"
  ;;
stats)
  eng node bin/reporter-stats.ts --grace "${GRACE:-60}" --log "$WORK/logs/reporter.jsonl" --out "$ROOT/deployments/$NAME-reporter-stats.json"
  ;;
*)
  echo "unknown step $step" >&2
  exit 2
  ;;
esac
