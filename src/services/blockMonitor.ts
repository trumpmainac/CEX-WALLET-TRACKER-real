import fs from 'fs/promises';
import path from 'path';
import { RpcManager } from '../loaders/rpc';
import { PublicKey } from '@solana/web3.js';
import { parseRanges, amountMatchesRanges } from './ranges.js';
import { parseBlockTransactions } from './blockParser.js';
import { log, error } from '../utils/logger.js';
import { sendAlert } from '../utils/telegram.js';
import { sleep } from '../utils/sleep.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const LAST_SLOT_FILE = path.join(DATA_DIR, 'lastSlot.json');

type CexConfig = { label: string; address: string; ranges: string };

async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {}
}

async function loadLastSlot(): Promise<Record<string, number>> {
  try {
    const raw = await fs.readFile(LAST_SLOT_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

async function saveLastSlot(map: Record<string, number>) {
  await ensureDataDir();
  await fs.writeFile(LAST_SLOT_FILE, JSON.stringify(map, null, 2), 'utf-8');
}

function readCexConfigs(): CexConfig[] {
  const configs: CexConfig[] = [];
  const env = process.env;
  Object.keys(env).forEach((k) => {
    const m = k.match(/^CEX_(\d+)_LABEL$/);
    if (m) {
      const n = m[1];
      const label = env[`CEX_${n}_LABEL`];
      const address = env[`CEX_${n}_ADDRESS`];
      const ranges = env[`CEX_${n}_RANGE`];
      if (label && address) {
        configs.push({ label, address, ranges: ranges ?? '' });
      }
    }
  });
  return configs;
}

export async function startBlockMonitor(rpc: RpcManager) {
  await ensureDataDir();
  const lastSlots = await loadLastSlot();
  const configs = readCexConfigs();

  log('Starting real-time block monitor for', configs.map((c) => `${c.label}:${c.address}`).join(', '));

  // Single shared monitor that watches all blocks
  (async () => {
    let lastSlot = 0;
    const blockPollMin = Number(process.env.BLOCK_POLL_MIN_MS ?? 0);
    const blockPollMax = Number(process.env.BLOCK_POLL_MAX_MS ?? 0);

    // Initialize to current slot on startup to avoid processing old blocks
    try {
      const conn = rpc.getConnection();
      lastSlot = await conn.getSlot('confirmed');
      log(`Bot initialized at block ${lastSlot}, will monitor from here forward`);
    } catch (e) {
      log('Warning: Could not initialize starting slot, will start from next available');
    }

    const blockFetchConcurrency = Number(process.env.BLOCK_FETCH_CONCURRENCY ?? 16);
    log(`Block fetch concurrency set to ${blockFetchConcurrency}`);

    while (true) {
      try {
        const conn = rpc.getConnection();
        const slot = await conn.getSlot('confirmed');

        if (slot > lastSlot) {
          // Process ALL blocks between lastSlot and current slot (fill gaps from skipped slots)
          const slotsToProcess: number[] = [];
          for (let s = lastSlot + 1; s <= slot; s++) slotsToProcess.push(s);

          // Process in concurrent batches to catch up faster (user accepts rate-limiting errors)
          for (let i = 0; i < slotsToProcess.length; i += blockFetchConcurrency) {
            const batch = slotsToProcess.slice(i, i + blockFetchConcurrency);
            log(`Fetching batch slots [${batch[0]}..${batch[batch.length - 1]}] (size=${batch.length})`);

            // Fetch all blocks in parallel, but buffer results so we can process in order
            const fetches = batch.map(async (s) => {
              try {
                const blockData = await conn.getBlock(s, { maxSupportedTransactionVersion: 0 });
                return { slot: s, blockData, err: null as any };
              } catch (err: any) {
                return { slot: s, blockData: null as any, err };
              }
            });

            const results = await Promise.all(fetches);
            const resultsBySlot = new Map<number, { slot: number; blockData: any; err: any }>();
            for (const r of results) resultsBySlot.set(r.slot, r);

            // Process batch slots in ascending order, but only advance lastSlot for
            // contiguous slots that are processed or legitimately skipped.
            let processedUpTo = lastSlot;
            for (const s of batch) {
              const res = resultsBySlot.get(s)!;
              if (res.err) {
                const msg = String(res.err?.message ?? res.err);
                // Treat skipped/missing-in-long-term-storage as processed (they won't appear later)
                if (msg.includes('skipped') || msg.includes('missing in long-term storage')) {
                  log(`Slot ${s} skipped or missing in long-term storage`);
                  processedUpTo = s;
                  continue;
                }

                // Transient error (rate limit, RPC error) — stop advancing further to preserve order
                error(`Error fetching block ${s}:`, msg);
                break;
              }

              // No block data (not produced yet)
              if (!res.blockData || !res.blockData.transactions) {
                // not produced yet; stop — we'll try again next loop
                break;
              }

              // We have a valid block — process it sequentially to preserve order
              log(`Processing block ${s}...`);
              try {
                const blockData = res.blockData;
                for (const tx of blockData.transactions) {
                  const signature = tx.transaction.signatures[0];
                  if (!signature) continue;

                  for (const cfg of configs) {
                    const ranges = parseRanges(cfg.ranges);
                    const outflows = parseBlockTransactions(tx as any, cfg.address);

                    if (outflows.length > 0) {
                      log(`[${cfg.label}] Found ${outflows.length} outflow(s) in tx ${signature.slice(0, 8)}...`);
                    }

                    for (const outflow of outflows) {
                      log(`[${cfg.label}] Outflow: ${outflow.amount} SOL to ${outflow.receiver.slice(0, 8)}...`);
                      if (!amountMatchesRanges(outflow.amount, ranges)) {
                        log(`[${cfg.label}] Amount ${outflow.amount} SOL does NOT match ranges: ${cfg.ranges}`);
                        continue;
                      }

                      const solscanLink = `https://solscan.io/tx/${signature}`;
                      const message = `<b>🚨 Range Match Alert</b>\n<b>CEX:</b> ${cfg.label}\n<b>Amount:</b> ${outflow.amount} SOL\n<b>Receiver:</b> ${outflow.receiver}\n<b>Tx:</b> <a href="${solscanLink}">View on Solscan</a>`;
                      log(`ALERT: ${cfg.label} sent ${outflow.amount} SOL to ${outflow.receiver}`);
                      await sendAlert(message);
                    }
                  }
                }
                // Successfully processed this slot
                processedUpTo = s;
              } catch (err: any) {
                error(`Error processing block ${s}:`, err?.message ?? err);
                // stop advancing on processing error to preserve order
                break;
              }
            }

            // Advance lastSlot only up to the last contiguous processed/skipped slot
            if (processedUpTo > lastSlot) {
              log(`Advanced lastSlot from ${lastSlot} to ${processedUpTo}`);
              lastSlot = processedUpTo;
            }
          }
        }

        const ms = blockPollMin + Math.random() * (blockPollMax - blockPollMin);
        await sleep(ms);
      } catch (err: any) {
        error('Block monitor RPC error:', err?.message ?? err);
        rpc.switchToSecondary();
        await sleep(5000);
      }
    }
  })();
}
