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
    const blockPollMin = Number(process.env.BLOCK_POLL_MIN_MS ?? 400);
    const blockPollMax = Number(process.env.BLOCK_POLL_MAX_MS ?? 700);

    while (true) {
      try {
        const conn = rpc.getConnection();
        const slot = await conn.getSlot('confirmed');

        if (slot > lastSlot) {
          log(`Processing block ${slot}...`);

          try {
            const blockData = await conn.getBlock(slot, { maxSupportedTransactionVersion: 0 });
            if (!blockData || !blockData.transactions) {
              lastSlot = slot;
              await sleep(blockPollMin + Math.random() * (blockPollMax - blockPollMin));
              continue;
            }

            // Process all transactions in this block
            for (const tx of blockData.transactions) {
              const signature = tx.transaction.signatures[0];
              if (!signature) continue;

              // Parse transaction for each CEX wallet
              for (const cfg of configs) {
                const ranges = parseRanges(cfg.ranges);
                const cexPubkey = cfg.address;

                const outflows = parseBlockTransactions(tx as any, cexPubkey);
                if (outflows.length === 0) continue;

                for (const outflow of outflows) {
                  if (!amountMatchesRanges(outflow.amount, ranges)) continue;

                  const solscanLink = `https://solscan.io/tx/${signature}`;
                  const message = `<b>🚨 Range Match Alert</b>\n<b>CEX:</b> ${cfg.label}\n<b>Amount:</b> ${outflow.amount} SOL\n<b>Receiver:</b> ${outflow.receiver}\n<b>Tx:</b> <a href="${solscanLink}">View on Solscan</a>`;
                  log(`ALERT: ${cfg.label} sent ${outflow.amount} SOL to ${outflow.receiver}`);
                  await sendAlert(message);
                }
              }
            }

            lastSlot = slot;
          } catch (err: any) {
            error(`Error processing block ${slot}:`, err?.message ?? err);
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
