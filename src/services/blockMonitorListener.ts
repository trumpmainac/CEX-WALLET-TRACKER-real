import fs from 'fs/promises';
import path from 'path';
import { RpcManager } from '../loaders/rpc';
import { parseRanges, amountMatchesRanges } from './ranges.js';
import { parseBlockTransactions } from './blockParser.js';
import { log, error } from '../utils/logger.js';
import { sendAlert } from '../utils/telegram.js';

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

export async function startBlockMonitorListener(rpc: RpcManager) {
  await ensureDataDir();
  const lastSlots = await loadLastSlot();
  const configs = readCexConfigs();

  log('🔄 Starting listener-based block monitor for', configs.map((c) => `${c.label}:${c.address}`).join(', '));

  const conn = rpc.getConnection();
  let lastSlot = 0;
  try {
    lastSlot = await conn.getSlot('confirmed');
    log(`🎧 Listener initialized at block ${lastSlot}, will monitor from here forward`);
  } catch (e) {
    log('Warning: Could not initialize starting slot, will start from next available');
  }

  // A small queue to ensure we process slots in order and avoid concurrent processing
  let processing = false;
  const slotQueue: number[] = [];

  async function queueSlot(s: number) {
    if (s <= lastSlot) return;
    if (slotQueue.includes(s)) return;
    slotQueue.push(s);
    slotQueue.sort((a, b) => a - b);
    if (!processing) await processQueue();
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    try {
      while (slotQueue.length > 0) {
        const s = slotQueue.shift()!;
        if (s <= lastSlot) continue;

        log(`📦 Fetching block ${s} (listener)`);
        try {
          const blockData = await conn.getBlock(s, { maxSupportedTransactionVersion: 0 });

          // Treat missing or skipped blocks similar to polling logic
          if (!blockData || !blockData.transactions) {
            log(`Slot ${s} skipped or missing in long-term storage (or not produced yet)`);
            lastSlot = s;
            log(`⏭️ Advanced lastSlot to ${lastSlot}`);
            await saveLastSlot({ lastSlot });
            continue;
          }

          log(`✅ Processing block ${s}...`);
          for (const tx of blockData.transactions) {
            const signature = tx.transaction.signatures?.[0];
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
                log(`🚨 ALERT: ${cfg.label} sent ${outflow.amount} SOL to ${outflow.receiver}`);
                await sendAlert(message);
              }
            }
          }

          lastSlot = s;
          log(`✨ Completed processing block ${s}; advanced lastSlot to ${lastSlot}`);
          await saveLastSlot({ lastSlot });
        } catch (err: any) {
          // Handle transient errors (rate limits) by logging and re-queueing
          const msg = String(err?.message ?? err);
          error(`Error fetching/processing block ${s}:`, msg);
          // Simple backoff: wait a bit then re-queue
          await new Promise((res) => setTimeout(res, 500));
          slotQueue.unshift(s);
          break; // stop until next attempt to avoid tight loops
        }
      }
    } finally {
      processing = false;
    }
  }

  const subscriptionId = conn.onSlotUpdate((slotUpdate) => {
    if (slotUpdate.type !== 'root') return; // only process rooted slots for stability
    queueSlot(slotUpdate.slot).catch((e) => error('Queue slot error', e));
  });

  log(`📡 Subscription established (id=${subscriptionId})`);

  process.on('SIGINT', async () => {
    log('🛑 Received SIGINT, removing slot subscription and shutting down');
    try {
      conn.removeSlotUpdateListener(subscriptionId);
    } catch (e) {}
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    log('🛑 Received SIGTERM, removing slot subscription and shutting down');
    try {
      conn.removeSlotUpdateListener(subscriptionId);
    } catch (e) {}
    process.exit(0);
  });
}

export default { startBlockMonitorListener };
