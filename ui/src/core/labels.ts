// Display names of a market's two tokens. The pair makes explicit that the product is the correlation between two
// assets (DEC-31); on chain the names are "CorrFi ETH/BTC <tenor>D #<id> Long / Short", symbols ETHBTC-L / ETHBTC-S.

export const PAIR = "ETH/BTC";
export const LONG = `${PAIR} Long`;
export const SHORT = `${PAIR} Short`;
export const sideName = (side: number) => (side === 0 ? LONG : SHORT);
