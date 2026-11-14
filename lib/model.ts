// Launch Radar's model: one sealed snapshot in, one ranked board out.
//
// Classification (all rules read only the snapshot's own ten fields):
//   pre-token   a protocol whose record carries no token at all: mcap_usd,
//               gecko_id and symbol are all null. This snapshot holds 342.
//   product     a pre-token record set aside by the same product rule the
//               snapshot's watchlist was built with: an excluded category
//               (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking,
//               Restaked BTC, CEX), a versioned name, a whole word wrapped /
//               staked / staking, or an exchange-name prefix. 144 records.
//   candidate   a pre-token protocol that is not a product: 198 records,
//               ranked by implied value. The 40-slug watchlist is a subset.
//   peer        a tokenised protocol with a usable market cap (mcap_usd > 0)
//               and TVL > 0: 128 records. Peers price the value model and
//               fill the backtest; the 30 largest by market cap are also
//               shown, unranked, in the dashboard's Already trading view.
//   Records that carry a token symbol but no market cap of their own (the
//   remaining 386) are deployments of families that already trade: they are
//   counted in the 758 scanned and are neither candidates nor peers.
//
// Value model (implemented exactly as the dashboard states it):
//   peer multiple for a category = market_cap / TVL of each peer in it
//   category multiple = median of the category's peer multiples, shrunk
//     toward the global median with K pseudo-peers:
//       mult = (n * category_median + K * global_median) / (n + K)
//     K = 6, or K = 12 when the category has fewer than 3 peers; the result
//     is clamped to [0.02, 2.00]. A category with no peers uses the global
//     median itself. value_lo / value_hi repeat the same shrink and clamp
//     with the category's Q1 / Q3 peer multiples in place of the median.
//   momentum  = 1 + 0.5 * clamp(change_7d, -50, +100) / 100   (0.75..1.50)
//   seasoning = 1 + 0.20 * min(age_days, 1460) / 1460          (1.00..1.20)
//   breadth   = min(1 + 0.03 * (chains - 1), 1.21)
//   implied_value_usd = tvl_usd * multiple * momentum * seasoning * breadth
// Age is counted from listed_at to the snapshot's as_of; a record with no
// listing date is seasoned with the median age of the pre-token protocols.
// No protocol name is ever special-cased: one function scores every row.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whole days from listed_at to as_of, clamped at zero; null when unlisted. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Linear-interpolation quantile of an ascending-sorted array. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

const medianOf = (values: number[]): number => quantile([...values].sort((a, b) => a - b), 0.5);

// ---------------------------------------------------------------- classify

/** A protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol whose token already trades and whose cap can price a peer multiple. */
export function isPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/**
 * The product rule that sets a pre-token record aside, or null when the record
 * is a protocol in its own right. The rule text travels with every product row
 * so the dashboard can name, for each of the 144, exactly why it was set aside.
 */
export function productRule(p: SnapshotProtocol): string | null {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) {
    return `Product — category ${p.category}: a wrapped, staked or bridged product class, not a protocol awaiting its own launch.`;
  }
  if (VERSIONED.test(p.name)) {
    return 'Product — versioned name: a later version of another protocol, not a separate launch.';
  }
  if (/\bwrapped\b/i.test(p.name)) {
    return 'Product — name carries the word wrapped: a wrapped form of a token that already trades.';
  }
  if (/\bstaked\b/i.test(p.name) || /\bstaking\b/i.test(p.name)) {
    return 'Product — name carries the word staked/staking: a staking product of a token that already trades.';
  }
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return `Product — name begins with the exchange name ${prefix}: an exchange product, not a standalone protocol.`;
  }
  return null;
}

// ---------------------------------------------------------------- multiples

export interface CategoryMultiple {
  category: string;
  peers: number;
  peer_median: number | null;
  multiple: number;
  multiple_lo: number;
  multiple_hi: number;
}

interface PeerIndex {
  globalMedian: number;
  globalQ1: number;
  globalQ3: number;
  peerTotal: number;
  byCategory: Map<string, number[]>;
  peersByCategory: Map<string, SnapshotProtocol[]>;
}

function buildPeerIndex(snapshot: Snapshot): PeerIndex {
  const peers = snapshot.protocols.filter(isPeer);
  const all = peers.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const byCategory = new Map<string, number[]>();
  const peersByCategory = new Map<string, SnapshotProtocol[]>();
  for (const p of peers) {
    const key = p.category ?? '';
    const arr = byCategory.get(key) ?? [];
    arr.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, arr);
    const list = peersByCategory.get(key) ?? [];
    list.push(p);
    peersByCategory.set(key, list);
  }
  for (const arr of byCategory.values()) arr.sort((a, b) => a - b);
  for (const list of peersByCategory.values()) {
    list.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || bySlugAsc(a.slug, b.slug));
  }
  return {
    globalMedian: quantile(all, 0.5),
    globalQ1: quantile(all, 0.25),
    globalQ3: quantile(all, 0.75),
    peerTotal: peers.length,
    byCategory,
    peersByCategory,
  };
}

/** One quartile's shrunk multiple: the same shrink and clamp, quartile in place of the median. */
function shrunkMultiple(peersSorted: number[], quartile: number, globalValue: number): number {
  const n = peersSorted.length;
  if (n === 0) return clamp(globalValue, 0.02, 2.0);
  const k = n < 3 ? 12 : 6;
  return clamp((n * quantile(peersSorted, quartile) + k * globalValue) / (n + k), 0.02, 2.0);
}

function multipleFor(index: PeerIndex, category: string | null): CategoryMultiple {
  const key = category ?? '';
  const arr = index.byCategory.get(key) ?? [];
  return {
    category: category ?? 'Uncategorised',
    peers: arr.length,
    peer_median: arr.length === 0 ? null : round6(quantile(arr, 0.5)),
    multiple: round6(shrunkMultiple(arr, 0.5, index.globalMedian)),
    multiple_lo: round6(shrunkMultiple(arr, 0.25, index.globalQ1)),
    multiple_hi: round6(shrunkMultiple(arr, 0.75, index.globalQ3)),
  };
}

// ---------------------------------------------------------------- farm plans

/** Gas price of one transaction, in dollars, by the class of the lead chain. */
const L2_CHAINS = new Set([
  'Arbitrum', 'Optimism', 'Base', 'Linea', 'Scroll', 'zkSync Era', 'Starknet', 'Polygon zkEVM',
  'Mantle', 'Metis', 'Mode', 'Blast', 'Taiko', 'Zircuit', 'Sophon', 'Unichain', 'Ink', 'Soneium',
  'Swellchain', 'MetalL2', 'Lisk', 'BOB', 'MegaETH', 'Katana', 'Arc', 'Plasma', 'Etherlink', 'Morph',
]);
const ALT_CHAINS = new Set([
  'Solana', 'Sui', 'Aptos', 'Near', 'Tron', 'Bitcoin', 'Litecoin', 'Doge', 'Cardano', 'Stellar',
  'Ripple', 'Algorand', 'Avalanche', 'Binance', 'Cronos', 'Fantom', 'Polygon', 'Kava', 'Sei',
  'Berachain', 'Monad', 'Hyperliquid L1', 'Bittensor', 'Bittensor EVM', 'Stacks', 'CORE', 'Celo',
]);

export function gasUnitFor(chain: string): number {
  if (chain === 'Ethereum') return 6;
  if (L2_CHAINS.has(chain)) return 1;
  if (ALT_CHAINS.has(chain)) return 1;
  return 2;
}

/** Working capital for one farm position, sized from the protocol's own TVL. Deployed, never spent. */
export function capitalFor(tvlUsd: number): number {
  if (tvlUsd >= 1_000_000_000) return 2500;
  if (tvlUsd >= 250_000_000) return 1500;
  if (tvlUsd >= 50_000_000) return 1000;
  if (tvlUsd >= 10_000_000) return 500;
  return 250;
}

interface CategoryAction {
  core: (name: string, chain: string, capital: number) => string;
  second: (name: string, chain: string, capital: number) => string;
  verb: string;
}

const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;

/** The per-category action table: every category on the board has an entry. */
const ACTIONS: Record<string, CategoryAction> = {
  'Dexs': {
    core: (n, c, k) => `Swap ${usd(k)} of the chain's base asset for USDC through ${n}'s main route on ${c}, then swap half back so both directions print on the farm wallet`,
    second: (n, c, k) => `Add ${usd(k)} as a two-sided liquidity position in ${n}'s deepest pool on ${c} and keep the LP position open instead of withdrawing after the swap`,
    verb: 'swap',
  },
  'Lending': {
    core: (n, c, k) => `Supply ${usd(k)} of USDC as collateral in ${n}'s main market on ${c} and leave the supply position open`,
    second: (n, c, k) => `Borrow ${usd(Math.round(k * 0.4))} against the supplied collateral in ${n}, hold it one day, then repay in full so the wallet shows both sides of the lending market`,
    verb: 'supply or borrow',
  },
  'Derivatives': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC as margin on ${n} on ${c} and open one small long position well inside the margin so liquidation is not a risk`,
    second: (n, c, k) => `Open an offsetting short of half the size on ${n} so the account runs hedged, and rebalance the pair once so both legs count as real trading activity`,
    verb: 'hedged trade',
  },
  'Risk Curators': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into a vault curated through ${n} on ${c}, choosing the vault with the deepest TVL the curator runs`,
    second: (n, c, k) => `Move ${usd(Math.round(k * 0.3))} of the position into a second ${n} vault on ${c} so the wallet holds shares in more than one curated strategy`,
    verb: 'vault deposit',
  },
  'Onchain Capital Allocator': {
    core: (n, c, k) => `Allocate ${usd(k)} of USDC into ${n}'s main allocation vault on ${c} and keep the vault shares in the farm wallet`,
    second: (n, c, k) => `Top the allocation up by ${usd(Math.round(k * 0.25))} after the first week so the wallet shows a second, separate deposit into ${n}`,
    verb: 'allocation',
  },
  'Yield': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n}'s main yield position on ${c} and keep the position's receipt token in the farm wallet`,
    second: (n, c, k) => `Claim the first yield payout ${n} issues on ${c} and redeposit it, so the wallet shows a harvest as well as a deposit`,
    verb: 'deposit',
  },
  'Yield Aggregator': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n}'s largest aggregator vault on ${c} and leave the auto-compounding position open`,
    second: (n, c, k) => `Withdraw ${usd(Math.round(k * 0.2))} and redeposit it a week later so ${n} records a full deposit cycle on the farm wallet`,
    verb: 'vault deposit',
  },
  'RWA': {
    core: (n, c, k) => `Mint ${usd(k)} of ${n}'s real-world-asset token on ${c} through its own issuance page and hold the minted asset`,
    second: (n, c, k) => `Move ${usd(Math.round(k * 0.3))} of the minted asset into ${n}'s yield or redemption route on ${c} so the wallet uses the asset, not just holds it`,
    verb: 'mint or transfer',
  },
  'CDP': {
    core: (n, c, k) => `Open a collateralised debt position in ${n} on ${c} with ${usd(k)} of collateral and mint a small amount of its stablecoin against it`,
    second: (n, c, k) => `Repay part of the minted debt and add ${usd(Math.round(k * 0.2))} more collateral so ${n} records both a mint and a repay from the wallet`,
    verb: 'mint or repay',
  },
  'CDP Manager': {
    core: (n, c, k) => `Open a managed vault in ${n} on ${c} with ${usd(k)} of collateral and draw a conservative amount of debt against it`,
    second: (n, c, k) => `Adjust the vault once — add ${usd(Math.round(k * 0.2))} of collateral — so ${n} records active vault management, not a dormant position`,
    verb: 'vault adjustment',
  },
  'Basis Trading': {
    core: (n, c, k) => `Commit ${usd(k)} of USDC to ${n}'s basis strategy on ${c}, which runs the spot leg and the hedge leg as one position`,
    second: (n, c, k) => `Add ${usd(Math.round(k * 0.25))} to the basis position after the first funding cycle so the wallet shows a second commitment to ${n}`,
    verb: 'strategy top-up',
  },
  'Chain': {
    core: (n, c, k) => `Bridge ${usd(k)} of USDC to ${c} and make ${n}'s own app the first contract the farm wallet calls on that chain`,
    second: (n, c, k) => `Pay for ${n}'s native activity on ${c} — a transfer and one app interaction — so the wallet builds a transaction history on the chain itself`,
    verb: 'on-chain transaction',
  },
  'Cross Chain Bridge': {
    core: (n, c, k) => `Route ${usd(k)} of USDC from ${c} to a second chain through ${n} and keep the bridged funds working at the destination`,
    second: (n, c, k) => `Route ${usd(Math.round(k * 0.4))} back through ${n} on a different corridor so the wallet shows routed volume in both directions`,
    verb: 'bridge transfer',
  },
  'Staking Pool': {
    core: (n, c, k) => `Stake ${usd(k)} of the chain's staking asset through ${n} on ${c} and keep the pool shares in the farm wallet`,
    second: (n, c, k) => `Claim the first staking reward ${n} pays on ${c} and restake it so the position compounds at least once`,
    verb: 'stake or claim',
  },
  'Restaking': {
    core: (n, c, k) => `Restake ${usd(k)} of a liquid staking token through ${n} on ${c} and keep the restaked position open`,
    second: (n, c, k) => `Delegate the restaked ${usd(k)} position to one of ${n}'s operators on ${c} so the wallet also records an operator choice`,
    verb: 'restake or delegate',
  },
  'Liquidity Manager': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into a managed liquidity vault run by ${n} on ${c} and hold the vault shares`,
    second: (n, c, k) => `Let ${n} rebalance the position through one full cycle, then top it up by ${usd(Math.round(k * 0.2))} so a second deposit is recorded`,
    verb: 'vault deposit',
  },
  'Leveraged Farming': {
    core: (n, c, k) => `Open a conservative leveraged farm in ${n} on ${c} with ${usd(k)} of USDC at the lowest leverage tier the app offers`,
    second: (n, c, k) => `Harvest the first farm reward inside ${n} and fold it back into the position so the wallet shows a full farm cycle`,
    verb: 'harvest',
  },
  'Anchor BTC': {
    core: (n, c, k) => `Deposit ${usd(k)} worth of BTC collateral into ${n} on ${c} and mint or borrow its anchored asset against the position`,
    second: (n, c, k) => `Repay part of the anchored balance and top the BTC collateral up by ${usd(Math.round(k * 0.2))} so both sides of ${n} are used`,
    verb: 'mint or repay',
  },
  'Decentralized BTC': {
    core: (n, c, k) => `Bridge ${usd(k)} worth of BTC into ${n} on ${c} through its own deposit route and hold the decentralised BTC asset it issues`,
    second: (n, c, k) => `Use ${usd(Math.round(k * 0.3))} of the issued asset in ${n}'s own market on ${c} so the wallet does more than hold the wrapped balance`,
    verb: 'deposit',
  },
  'CeDeFi': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n}'s main earn product on ${c} and keep the position open for the full hold`,
    second: (n, c, k) => `Claim the first interest payout from ${n} and redeposit it so the wallet records a complete earn cycle`,
    verb: 'deposit or claim',
  },
  'Dual-Token Stablecoin': {
    core: (n, c, k) => `Mint ${usd(k)} of ${n}'s stablecoin on ${c} by depositing its accepted collateral through the protocol's own mint page`,
    second: (n, c, k) => `Stake ${usd(Math.round(k * 0.4))} of the minted stablecoin in ${n}'s savings side on ${c} so the wallet touches both tokens of the pair`,
    verb: 'mint or stake',
  },
  'Stablecoin Wrapper': {
    core: (n, c, k) => `Wrap ${usd(k)} of the underlying stablecoin through ${n} on ${c} and hold the wrapped balance it returns`,
    second: (n, c, k) => `Unwrap ${usd(Math.round(k * 0.25))} and wrap it again a week later so ${n} records a full wrap cycle on the wallet`,
    verb: 'wrap or unwrap',
  },
  'Farm': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n}'s main farm on ${c} and stake the position's receipt in its reward contract`,
    second: (n, c, k) => `Harvest the first reward ${n} pays on ${c} and restake it into the same farm so the position compounds`,
    verb: 'harvest',
  },
  'Prediction Market': {
    core: (n, c, k) => `Fund ${usd(k)} on ${n} on ${c} and buy one position in its most liquid market at the quoted price`,
    second: (n, c, k) => `Sell or settle the first position on ${n} and open a second, smaller one so the wallet shows a completed trade, not just a deposit`,
    verb: 'trade',
  },
  'Uncollateralized Lending': {
    core: (n, c, k) => `Supply ${usd(k)} of USDC to ${n}'s main lending pool on ${c} under its credit terms and leave the supply open`,
    second: (n, c, k) => `Claim the first interest payment ${n} issues on ${c} so the wallet records yield from the uncollateralised pool`,
    verb: 'supply or claim',
  },
  'Interest Rate Derivatives': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC on ${n} on ${c} and buy one fixed-rate position at the quoted rate for the hold period`,
    second: (n, c, k) => `Trade ${usd(Math.round(k * 0.3))} of the position's yield token on ${n} so the wallet uses the derivatives side as well as the deposit side`,
    verb: 'rate trade',
  },
  'OTC Marketplace': {
    core: (n, c, k) => `List or fill one ${usd(k)} order on ${n} on ${c} at the quoted price, using the marketplace's own escrow flow`,
    second: (n, c, k) => `Complete a second, smaller order on ${n} so the wallet shows repeat marketplace activity rather than a single fill`,
    verb: 'order',
  },
  'Insurance': {
    core: (n, c, k) => `Buy ${usd(k)} of cover from ${n} on ${c} for the farm wallet's main position and keep the policy active for the hold`,
    second: (n, c, k) => `Stake ${usd(Math.round(k * 0.3))} into ${n}'s underwriting pool on ${c} so the wallet also supplies cover, not only buys it`,
    verb: 'cover purchase',
  },
  'Payments': {
    core: (n, c, k) => `Send ${usd(k)} through ${n} on ${c} to a second wallet you control, using its own payment route end to end`,
    second: (n, c, k) => `Make one merchant-style payment of ${usd(Math.round(k * 0.2))} through ${n} so the wallet shows both a transfer and a payment`,
    verb: 'payment',
  },
  'Governance Incentives': {
    core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n}'s main incentivised pool on ${c} and register the wallet for its governance rewards`,
    second: (n, c, k) => `Vote in the first ${n} governance poll the wallet is eligible for on ${c}, however small the voting weight`,
    verb: 'vote or deposit',
  },
  'Crypto Card Issuer': {
    core: (n, c, k) => `Load ${usd(k)} onto ${n}'s card account from ${c} through its own top-up route and keep the balance loaded`,
    second: (n, c, k) => `Make one ordinary card payment from the ${n} balance so the account shows real spend, not only a top-up`,
    verb: 'top-up or spend',
  },
  'Indexes': {
    core: (n, c, k) => `Mint ${usd(k)} of ${n}'s main index token on ${c} through its own issuance route and hold the index position`,
    second: (n, c, k) => `Redeem ${usd(Math.round(k * 0.2))} of the index and mint it back a week later so ${n} records a full issuance cycle`,
    verb: 'mint or redeem',
  },
  'Collateral Markets': {
    core: (n, c, k) => `Post ${usd(k)} of collateral into ${n}'s main market on ${c} and open the smallest position the market allows against it`,
    second: (n, c, k) => `Add ${usd(Math.round(k * 0.2))} more collateral to the ${n} position so the wallet shows active collateral management`,
    verb: 'collateral adjustment',
  },
};

const FALLBACK_ACTION: CategoryAction = {
  core: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n} on ${c} through its own app and keep the position open`,
  second: (n, c, k) => `Make a second, smaller deposit of ${usd(Math.round(k * 0.25))} into ${n} a week later so the wallet shows repeat use`,
  verb: 'deposit',
};

export interface FarmPlan {
  capital_usd: number;
  gas_usd: number;
  hold_days: number;
  weeks: number;
  minutes_total: number;
  minutes_per_week: number;
}

/**
 * One protocol's eight-step farm plan. The category picks the actions, the
 * lead chain prices the gas, TVL sizes the capital, age sets the hold. Step
 * costs are out-of-pocket gas and fees only; working capital is deployed,
 * never spent, and appears in the step text but never in a cost tail. Every
 * step ends with the tail ` [cost $X | Y min]` the dashboard parses.
 */
export function farmPlan(p: SnapshotProtocol, ageDaysEffective: number): { plan: FarmPlan; steps: string[] } {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p.tvl_usd);
  const action = ACTIONS[p.category ?? ''] ?? FALLBACK_ACTION;
  const unit = gasUnitFor(chain);
  const holdDays = clamp(84 - 7 * Math.floor(Math.max(0, ageDaysEffective) / 365), 28, 84);
  const weeks = Math.ceil(holdDays / 7);
  const name = p.name;
  // [text body, transactions, minutes]
  const raw: Array<[string, number, number]> = [
    [`Set up a fresh farm wallet for ${name}, back its seed phrase up offline, and fund it on ${chain} with the gas token plus ${usd(capital)} of working capital so no later step waits on a top-up`, 1, 12],
    [`${action.core(name, chain, capital)}; the ${usd(capital)} is deployed capital that stays yours, and only the transaction fees leave the wallet`, 2, 18],
    [`${action.second(name, chain, capital)}, keeping every receipt and share token in the same farm wallet`, 2, 15],
    [`Repeat one qualifying ${action.verb} on ${name} every week for ${weeks} weeks, always from the same wallet, so the activity spans the whole ${holdDays}-day hold instead of a single session`, weeks, 6 * weeks],
    [`At the midpoint of the hold, add ${usd(Math.round(capital * 0.2))} more to the ${name} position on ${chain} and screenshot the position page so the balance and the dates are on record`, 2, 14],
    [`Open ${name}'s own points, rewards or governance page, check the farm wallet's standing there, and cast any vote or claim-prep transaction it offers — never follow a claim link from anywhere else`, 1, 10],
    [`After ${holdDays} days, unwind the ${name} position on ${chain} in the reverse order it was opened, moving the recovered capital and any rewards back to the farm wallet's home chain`, 2, 16],
    [`Log every transaction hash, date and fee for ${name} in a farm ledger, then send one final small ${action.verb} so the wallet's last activity is recent if a snapshot is taken late`, 1, 8],
  ];
  const steps = raw.map(([body, txs, minutes]) => {
    const cost = Math.max(1, Math.round(unit * txs));
    return `${body}. This step costs $${cost} in gas and fees out of pocket and takes ${minutes} minutes of hands-on time. [cost $${cost} | ${minutes} min]`;
  });
  const gas = steps.reduce((sum, s) => sum + Number(/\[cost \$(\d+) \|/.exec(s)![1]), 0);
  const minutesTotal = raw.reduce((sum, [, , m]) => sum + m, 0);
  return {
    plan: {
      capital_usd: capital,
      gas_usd: gas,
      hold_days: holdDays,
      weeks,
      minutes_total: minutesTotal,
      minutes_per_week: Math.round(minutesTotal / weeks),
    },
    steps,
  };
}

// ---------------------------------------------------------------- the board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number;
  watchlist: boolean;
  implied_value_usd: number;
  value_lo_usd: number;
  value_hi_usd: number;
  factors: {
    category_multiple: number;
    multiple_lo: number;
    multiple_hi: number;
    peer_count: number;
    momentum: number;
    seasoning: number;
    breadth: number;
  };
  plan: FarmPlan;
  farm_steps: string[];
}

export interface ProductRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  rule: string;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  symbol: string | null;
}

export interface PeerRow {
  slug: string;
  name: string;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    scanned: number;
    pre_token: number;
    candidates: number;
    products: number;
    live_shown: number;
    peer_total: number;
    watchlist_size: number;
    median_age_days: number;
    global_median: number;
    global_q1: number;
    global_q3: number;
  };
  backtest: { tested: number; median_ape: number; hit_rate: number; hits: number };
  multiples: CategoryMultiple[];
  rows: BoardRow[];
  products: ProductRow[];
  live: LiveRow[];
  peers: Record<string, PeerRow[]>;
}

export interface BuiltRadar {
  board: BoardRow[];
  data: RadarData;
}

/** Everything the dashboard renders and board.json carries, from one snapshot. */
export function buildRadar(snapshot: Snapshot): BuiltRadar {
  const index = buildPeerIndex(snapshot);
  const watch = new Set(snapshot.watchlist);
  const preToken = snapshot.protocols.filter(isPreToken);
  const medianAge = Math.round(medianOf(preToken.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null)));

  const products: ProductRow[] = [];
  const candidates: SnapshotProtocol[] = [];
  for (const p of preToken) {
    const rule = productRule(p);
    if (rule !== null) {
      products.push({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, listed_at: p.listed_at, rule });
    } else {
      candidates.push(p);
    }
  }
  products.sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug));

  const scored = candidates.map((p) => {
    const mult = multipleFor(index, p.category);
    const age = ageDays(snapshot.as_of, p.listed_at) ?? medianAge;
    const momentum = round6(1 + 0.5 * (clamp(p.change_7d ?? 0, -50, 100) / 100));
    const seasoning = round6(1 + 0.2 * (Math.min(age, 1460) / 1460));
    const breadth = round6(Math.min(1 + 0.03 * Math.max(0, p.chains.length - 1), 1.21));
    const implied = Math.max(1, Math.round(p.tvl_usd * mult.multiple * momentum * seasoning * breadth));
    const lo = Math.max(1, Math.round(p.tvl_usd * mult.multiple_lo * momentum * seasoning * breadth));
    const hi = Math.max(1, Math.round(p.tvl_usd * mult.multiple_hi * momentum * seasoning * breadth));
    const { plan, steps } = farmPlan(p, age);
    return { p, mult, age, momentum, seasoning, breadth, implied, lo, hi, plan, steps };
  });
  scored.sort((a, b) => b.implied - a.implied || bySlugAsc(a.p.slug, b.p.slug));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.implied,
    value_lo_usd: s.lo,
    value_hi_usd: s.hi,
    factors: {
      category_multiple: s.mult.multiple,
      multiple_lo: s.mult.multiple_lo,
      multiple_hi: s.mult.multiple_hi,
      peer_count: s.mult.peers,
      momentum: s.momentum,
      seasoning: s.seasoning,
      breadth: s.breadth,
    },
    plan: s.plan,
    farm_steps: s.steps,
  }));

  // The multiples table: one row per category on the board, deepest peer sets first.
  const boardCategories = [...new Set(board.map((r) => r.category ?? 'Uncategorised'))];
  const multiples = boardCategories
    .map((c) => multipleFor(index, c === 'Uncategorised' ? null : c))
    .sort((a, b) => b.peers - a.peers || bySlugAsc(a.category, b.category));

  // The named peers behind each board category's multiple, for the detail view.
  const peers: Record<string, PeerRow[]> = {};
  for (const c of boardCategories) {
    const list = index.peersByCategory.get(c === 'Uncategorised' ? '' : c) ?? [];
    if (list.length > 0) {
      peers[c] = list.map((p) => ({ slug: p.slug, name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, multiple: round6(p.mcap_usd! / p.tvl_usd) }));
    }
  }

  // Backtest: price every peer with its own category's shrunk multiple.
  const peerList = snapshot.protocols.filter(isPeer);
  const apes: number[] = [];
  let hits = 0;
  for (const p of peerList) {
    const fitted = p.tvl_usd * multipleFor(index, p.category).multiple;
    apes.push(Math.abs(fitted - p.mcap_usd!) / p.mcap_usd!);
    if (fitted >= 0.5 * p.mcap_usd! && fitted <= 2 * p.mcap_usd!) hits++;
  }
  const backtest = {
    tested: peerList.length,
    median_ape: round6(quantile([...apes].sort((a, b) => a - b), 0.5)),
    hit_rate: round6(peerList.length === 0 ? 0 : hits / peerList.length),
    hits,
  };

  // Already trading: the 30 largest tokenised protocols by market cap, unranked.
  const live: LiveRow[] = [...peerList]
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || bySlugAsc(a.slug, b.slug))
    .slice(0, 30)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, change_7d: p.change_7d, symbol: p.symbol }));

  const data: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      scanned: snapshot.protocols.length,
      pre_token: preToken.length,
      candidates: board.length,
      products: products.length,
      live_shown: live.length,
      peer_total: index.peerTotal,
      watchlist_size: snapshot.watchlist.length,
      median_age_days: medianAge,
      global_median: round6(index.globalMedian),
      global_q1: round6(index.globalQ1),
      global_q3: round6(index.globalQ3),
    },
    backtest,
    multiples,
    rows: board,
    products,
    live,
    peers,
  };
  return { board, data };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is clean. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  for (const r of board) {
    if (r.farm_steps.length !== 8) return `${r.slug} has ${r.farm_steps.length} farm steps, not 8`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
