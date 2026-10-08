// Reference accounting for the Unbroken boost (Season 1). Unbroken is a tag on tokens, not on wallets.
// Amounts are integers (token wei). Pure functions: the indexer applies the same steps to every $EPH Transfer.

export type Wallet = { balance: bigint; tagged: bigint }; // tagged <= balance always
export type Ledger = Map<string, Wallet>;

const get = (l: Ledger, w: string): Wallet => l.get(w.toLowerCase()) ?? { balance: 0n, tagged: 0n };
const put = (l: Ledger, w: string, v: Wallet) => l.set(w.toLowerCase(), v);

/** A buy from the official pool: the bought tokens carry the tag. */
export function buy(l: Ledger, w: string, amount: bigint): void {
  const a = get(l, w);
  put(l, w, { balance: a.balance + amount, tagged: a.tagged + amount });
}

/** A sell into a pool clears the tag on everything that wallet still holds. */
export function sell(l: Ledger, w: string, amount: bigint): void {
  const a = get(l, w);
  if (amount > a.balance) throw new Error('sell exceeds balance');
  put(l, w, { balance: a.balance - amount, tagged: 0n });
}

/**
 * A transfer carries the sender's tagged share, pro rata, rounded down.
 * The sender keeps at most its new balance tagged, so tagged totals can only stay equal or shrink by rounding.
 */
export function transfer(l: Ledger, from: string, to: string, amount: bigint): void {
  const a = get(l, from);
  if (amount > a.balance) throw new Error('transfer exceeds balance');
  if (from.toLowerCase() === to.toLowerCase()) return;
  const moved = a.balance === 0n ? 0n : (amount * a.tagged) / a.balance;
  const fromBalance = a.balance - amount;
  let fromTagged = a.tagged - moved;
  if (fromTagged > fromBalance) fromTagged = fromBalance;
  put(l, from, { balance: fromBalance, tagged: fromTagged });
  const b = get(l, to);
  put(l, to, { balance: b.balance + amount, tagged: b.tagged + moved });
}

export const totalTagged = (l: Ledger) => [...l.values()].reduce((s, w) => s + w.tagged, 0n);
export const totalBalance = (l: Ledger) => [...l.values()].reduce((s, w) => s + w.balance, 0n);
