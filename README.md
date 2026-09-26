# CorrFi

I built **"CorrFi"** for ETHGlobal Tokyo 2026!!

This project is building DeFi protocol, which provides an exposure to a **"Correlation"** risk between multi asset.
You can take Long and Short views on future correlation.

## Table of contents
**0.For 1inch judges: where to look**
<br>**1.Problem**
<br>**2.Solution and overview**
<br>**3.How it works**
<br>**4.Aqua and SwapVM: why and how**
<br>**5.Deployments and on-chain proof**
<br>**6.Demo and try it**
<br>**7.Verification and tests**
<br>**8.What this does not claim**

## 0.For 1inch judges: where to look

<!-- One row per 1inch prize requirement (official Aqua/SwapVM contracts, on-chain token transfers, commit history, sophisticated position, SwapVM usage) with links to the evidence: files, transactions, test commands. -->

## 1.Problem

### >>>>>Many crypto portfolios are exposed to the independent risk, Correlation risk.<<<<<

### Who is most exposed to this risk?
### ⇒Options / Volatility / Dispersion traders, Crypto Market Makers / Multi-asset trading firms, DeFi Treasury / Funds / Vaults

Crypto assets often experience sharp rises and falls. Then, most crypto assets tend to move in the same direction.
In other words, **correlations among crypto assets tend to increase!!!!!!** This is a major factor that makes crypto portfolios highly susceptible to directional momentum and volatility. Even if a portfolio is constructed using assets that appear to have low correlations with one another, those statistical relationships can break down during periods of strong momentum.
It is extremely difficult to hedge correlation risk using only existing on-chain financial products. Moreover, there are very few protocols that directly provide instruments for hedging correlation risk.



## 2.Solution and overview

CorrFi provides the direct way to hedge against Correlation.
With CorrFi, users can take long or short positions on future correlation. This enables them to directly hedge exposure to price correlation between assets during extreme market regimes in on-chain financial markets.

### Protocol overview

CorrFi is an MVP protocol for correlation derivatives based on the realized correlation between ETH and BTC. Users can mint Long and Short tokens using 1 USDC as collateral, with settlement determined by the realized correlation at maturity across three markets: 7, 14, and 28 days.

The protocol is built on 1inch Aqua, a liquidity layer that allows Makers to share their capital across multiple markets through virtual balances, and SwapVM, an execution framework that enables custom pricing logic to be expressed through dedicated opcodes. AquaCorr will be deployed on the Base Sepolia testnet.

Fair value is determined through a push-based mechanism in which an on-chain contract deterministically recomputes realized correlation from 5-minute VWAP log returns sourced from multiple exchanges. Makers do not participate in the price-calculation process; they are responsible only for providing liquidity and setting risk limits. Takers can call swap and quote functions without supplying any external data themselves.

An off-chain reporter bot submits price data every five minutes. However, an update is rejected unless the submitted values are consistent with the contract’s deterministic recomputation. In other words, while an external data source may attempt to provide false data, it cannot alter or falsify the calculation logic itself.

Risk-management controls, including inventory caps and circuit-breaker conditions, are also embedded directly into the protocol as invariants.

**This is an MVP built for ETHGlobal Tokyo 2026 and currently supports only BTC/ETH correlation. The broader goal, however, is to provide correlation markets across multiple asset pairs.**

## 3.How it works

<!-- Fair value on-chain; bid / ask from the fair value (base spread + risk surcharge); settlement value Long_T = (1 + rho) / 2. Architecture diagram (mermaid): reporter -> hub (fair value); taker -> router (SwapVM program) <-> Aqua <-> maker wallet; hooks -> vault (mint / burn). -->

## 4.Aqua and SwapVM: why and how

### Why Aqua and SwapVM

<!-- Why a correlation market needs Aqua's shared liquidity and SwapVM's custom pricing; alternatives we rejected. -->

### How we use them

<!-- Custom opcodes 0xd0 CorrReport / 0xd1 CorrCurve / 0xd2 CorrGuard (name, file, role); the program Deadline -> CorrReport -> CorrCurve -> CorrGuard; the router as SwapVM router, Aqua app and maker hook; ship -> pull / push -> dock; pinned versions (Aqua v1.0.0 official and unmodified, SwapVM pinned commit inherited by the router). -->

## 5.Deployments and on-chain proof

<!-- Base Sepolia addresses with verified explorer links (Aqua official and unmodified, CorrFiRouter, hub, lens, vaults, tUSDC, libraries) and transaction links: ship, the four swap directions, a hook mint, finalize, redeem. -->

## 6.Demo and try it

<!-- Demo video and live site. Try it: get tUSDC on the faucet page -> trade Long / Short on the trade page -> redeem after maturity. Run it locally: cd ui && npm run live; the 7D replay demo. -->

## 7.Verification and tests

<!-- Invariants (quote = breakdown = swap; collateral = supply; Solidity / TypeScript / Python fixed-point results identical to the bit; the replay's V1-V8 checks and deterministic final state) and a table: suite -> what it proves -> count -> command. Backtest in 2-3 lines: B1 pass and the adopted parameters. -->

## 8.What this does not claim

<!-- Testnet only; SwapVM main is unaudited; the reporter is trusted for the price points (the contract enforces the math); tUSDC is a test token; the gold pairs are not listed yet. -->

---

Powered by SwapVM — © Degensoft Ltd 2025 · Aqua — © Degensoft Ltd 2025. CorrFi is not affiliated with 1inch or Degensoft.
