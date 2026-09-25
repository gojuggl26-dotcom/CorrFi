"""AquaCorr market-data processing (S02): normalized 1-minute bars -> 5-minute / 1-minute price points.

Spec: M §2.5.1 (p.8), R §3.1 (p.7), B §2.2-2.3 (p.4).
"""

VENUES = ("binance", "okx", "bybit", "bitget", "kucoin")
SYMBOLS = ("ETHUSDT", "BTCUSDT")  # asset A = ETH, asset B = BTC (M §2.5.1)
MIN_VALID_VENUES = 3
BAR_SECONDS = 300    # Δ (M §1.9 p.6)
VWAP_SECONDS = 60    # window [t-60, t)
