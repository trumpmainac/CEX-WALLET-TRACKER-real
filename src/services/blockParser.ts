import { VersionedTransaction, PublicKey } from '@solana/web3.js';

type Outflow = { amount: number; receiver: string; type: 'SOL' };

export function parseBlockTransactions(tx: any, cexAddress: string): Outflow[] {
  const results: Outflow[] = [];
  const meta = tx.meta;
  if (!meta) return results;

  const message = tx.transaction.message;
  const accountKeys = message.staticAccountKeys || message.accountKeys || [];
  
  // Find CEX address index
  const cexIdx = accountKeys.findIndex((k: any) => {
    const addr = typeof k === 'string' ? k : k?.toBase58?.();
    return addr === cexAddress;
  });
  if (cexIdx === -1) return results;

  // Check SOL balance change
  if (meta.preBalances && meta.postBalances) {
    const pre = meta.preBalances[cexIdx] ?? 0;
    const post = meta.postBalances[cexIdx] ?? 0;
    const lamportsOut = pre - post;

    if (lamportsOut > 0) {
      // Find receiver: account that gained the most SOL
      let receiver = '';
      let maxGain = 0;
      for (let i = 0; i < (meta.postBalances?.length ?? 0); i++) {
        const gain = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
        if (gain > maxGain && i !== cexIdx) {
          maxGain = gain;
          const addr = accountKeys[i];
          receiver = typeof addr === 'string' ? addr : addr?.toBase58?.() || String(addr);
        }
      }
      if (receiver && maxGain > 0) {
        results.push({ amount: lamportsOut / 1e9, receiver, type: 'SOL' });
      }
    }
  }

  return results;
}
