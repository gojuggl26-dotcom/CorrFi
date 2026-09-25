# CorrFi

I built **"CorrFi"** for ETHGlobal Tokyo 2026!!

This project is building DeFi protocol, which provides an exposure to a **"Correlation"** risk between multi asset.
You can take Long and Short views on future correlation.

## Table of contents
**1.Problem**
<br>**2.Solution**
<br>**3.protocol Overview**
<br>**4.How do you use?**
<br>**5.How does it work?**
<br>**6.Why Aqua and SwapVM?**
<br>**7.How did I use Aqua and SwapVM?**

## 1.Problem

### >>>>>Many crypto portfolios are exposed to the independent risk, Correlation risk.<<<<<

### Who is most exposed to this risk?
### ⇒Options / Volatility / Dispersion traders, Crypto Market Makers / Multi-asset trading firms, DeFi Treasury / Funds / Vaults

Crypto assets often experience sharp rises and falls. Then, most crypto assets tend to move in the same direction.
In other words, **correlations among crypto assets tend to increase!!!!!!** This is a major factor that makes crypto portfolios highly susceptible to directional momentum and volatility. Even if a portfolio is constructed using assets that appear to have low correlations with one another, those statistical relationships can break down during periods of strong momentum.
It is extremely difficult to hedge correlation risk using only existing on-chain financial products. Moreover, there are very few protocols that directly provide instruments for hedging correlation risk.



## 2.Solution

CorrFi provides the direct way to hedge against Correlation.
With CorrFi, users can take long or short positions on future correlation. This enables them to directly hedge exposure to price correlation between assets during extreme market regimes in on-chain financial markets.

## 3.protocol overview

CorrFi is an MVP protocol for correlation derivatives based on the realized correlation between ETH and BTC. Users can mint Long and Short tokens using 1 USDC as collateral, with settlement determined by the realized correlation at maturity across three markets: 7, 14, and 28 days.

The protocol is built on 1inch Aqua, a liquidity layer that allows Makers to share their capital across multiple markets through virtual balances, and SwapVM, an execution framework that enables custom pricing logic to be expressed through dedicated opcodes. AquaCorr will be deployed on the Base Sepolia testnet.

Fair value is determined through a push-based mechanism in which an on-chain contract deterministically recomputes realized correlation from 5-minute VWAP log returns sourced from multiple exchanges. Makers do not participate in the price-calculation process; they are responsible only for providing liquidity and setting risk limits. Takers can call swap and quote functions without supplying any external data themselves.

An off-chain reporter bot submits price data every five minutes. However, an update is rejected unless the submitted values are consistent with the contract’s deterministic recomputation. In other words, while an external data source may attempt to provide false data, it cannot alter or falsify the calculation logic itself.

Risk-management controls, including inventory caps and circuit-breaker conditions, are also embedded directly into the protocol as invariants.

**This is an MVP built for ETHGlobal Tokyo 2026 and currently supports only BTC/ETH correlation. The broader goal, however, is to provide correlation markets across multiple asset pairs.**







