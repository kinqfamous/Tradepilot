#!/usr/bin/env tsx
/**
 * One-time administrative script: registers TradePilot's Phoenix Flight
 * builder authority and sets its fee. This is NOT part of the bot's
 * runtime and must never be run automatically or triggered from Telegram
 * (see spec section 3: "Do not run builder registration during normal
 * trades.").
 *
 * SECURITY: the builder's private key is read from a local keypair FILE
 * path you provide on the command line - never from this project's .env,
 * never committed to git, never touched by the bot process itself.
 * Standard Solana CLI keypair JSON format (array of 64 bytes), e.g.
 * generated with `solana-keygen new -o builder-keypair.json`. Delete or
 * move that file somewhere secure once you're done here.
 *
 * Usage (two ways to supply the signer - pick ONE):
 *   npx tsx scripts/register-phoenix-flight-builder.ts --keypair ./builder-keypair.json --fee-bps 8
 *   npx tsx scripts/register-phoenix-flight-builder.ts --env-keypair --fee-bps 8
 *     (reads BUILDER_AUTHORITY_PRIVATE_KEY_BASE58 from .env.builder-signer -
 *      see .env.builder-signer.example for the template and why this file
 *      is kept separate from the bot's main .env)
 *
 * Alternative: if you've already registered via https://flight.phoenix.trade
 * directly with your own wallet, you don't need this script at all - just
 * set TRADEPILOT_BUILDER_AUTHORITY in .env to that account's public key
 * and the bot will pick it up on next boot.
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import bs58 from 'bs58';
import { Keypair, Connection, sendAndConfirmTransaction, Transaction } from '@solana/web3.js';
import { createPhoenixClient, flight, MarginType } from '@ellipsis-labs/rise';
import { config } from '../src/config/env';

interface CliArgs {
  keypairPath?: string;
  useEnvKeypair: boolean;
  feeBps: number;
  pdaIndex: number;
  subaccountIndex: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const keypairPath = get('--keypair');
  const useEnvKeypair = has('--env-keypair');

  if (!keypairPath && !useEnvKeypair) {
    console.error('Missing signer: pass either --keypair <path-to-local-keypair.json> or --env-keypair.');
    console.error('Examples:');
    console.error('  npx tsx scripts/register-phoenix-flight-builder.ts --keypair ./builder-keypair.json --fee-bps 8');
    console.error('  npx tsx scripts/register-phoenix-flight-builder.ts --env-keypair --fee-bps 8');
    process.exit(1);
  }

  return {
    keypairPath,
    useEnvKeypair,
    feeBps: Number(get('--fee-bps', String(config.flight.builderFeeBps))),
    pdaIndex: Number(get('--pda-index', String(config.flight.builderPdaIndex))),
    subaccountIndex: Number(get('--subaccount-index', String(config.flight.builderSubaccountIndex))),
  };
}

function loadKeypairFromFile(keypairPath: string): Keypair {
  const resolved = path.resolve(keypairPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Keypair file not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Loads the signer from .env.builder-signer - a file this script reads
 * directly and explicitly, completely separate from the bot's dotenv
 * config in src/config/env.ts (which never references this path or these
 * variable names). This isolation is intentional: see file header.
 */
function loadKeypairFromEnvFile(): Keypair {
  const envPath = path.resolve(process.cwd(), '.env.builder-signer');
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `.env.builder-signer not found. Copy .env.builder-signer.example to .env.builder-signer ` +
        `and fill in BUILDER_AUTHORITY_PRIVATE_KEY_BASE58 first.`,
    );
  }

  const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  const base58Key = parsed.BUILDER_AUTHORITY_PRIVATE_KEY_BASE58;
  if (!base58Key) {
    throw new Error('BUILDER_AUTHORITY_PRIVATE_KEY_BASE58 is empty in .env.builder-signer.');
  }

  return Keypair.fromSecretKey(bs58.decode(base58Key.trim()));
}

function loadKeypair(args: CliArgs): Keypair {
  return args.useEnvKeypair ? loadKeypairFromEnvFile() : loadKeypairFromFile(args.keypairPath!);
}

function explorerLink(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!Number.isInteger(args.feeBps) || args.feeBps < 0 || args.feeBps > 500) {
    throw new Error('--fee-bps must be a whole number between 0 and 500 (5%).');
  }

  console.log('=== TradePilot Phoenix Flight Builder Registration ===\n');

  // 1. Load the configured builder authority (from a local keypair file or
  //    the isolated .env.builder-signer - never the bot's main .env)
  const builderKeypair = loadKeypair(args);
  const builderAuthority = builderKeypair.publicKey.toBase58();
  console.log(`Builder authority:      ${builderAuthority}`);
  console.log(`Trader PDA index:       ${args.pdaIndex}`);
  console.log(`Subaccount index:       ${args.subaccountIndex}`);
  console.log(`Fee (bps):              ${args.feeBps} (${(args.feeBps / 100).toFixed(2)}%)\n`);

  // 2. Connect to the configured Solana RPC
  const connection = new Connection(config.phoenix.solanaRpcUrl, 'confirmed');

  const client = createPhoenixClient({
    apiUrl: config.phoenix.restUrl,
    rpcUrl: config.phoenix.solanaRpcUrl,
    exchangeMetadata: { stream: false },
  });
  await client.exchange.ready();

  // 3 & 4. Verify the builder account / associated Phoenix trader account
  console.log('Checking existing trader account state...');
  let alreadyRegisteredAsTrader = false;
  try {
    const snapshot = await client.api
      .traders()
      .getTraderStateSnapshot(builderAuthority, { traderPdaIndex: args.pdaIndex });
    alreadyRegisteredAsTrader = Boolean(snapshot);
    console.log(
      alreadyRegisteredAsTrader
        ? '  -> Trader account already exists.'
        : '  -> No existing trader account found.',
    );
  } catch {
    console.log('  -> No existing trader account found (or lookup failed) - will attempt registration.');
  }

  const instructions: unknown[] = [];

  // 5 & 6. Verify / register the trader account the builder rides on
  if (!alreadyRegisteredAsTrader) {
    console.log('Building trader registration instruction...');
    const registerTraderIx = await client.ixs.buildRegisterTrader({
      authority: builderAuthority,
      marginType: MarginType.Cross,
    });
    instructions.push(registerTraderIx);
  }

  // 7. Register as a Flight builder with the configured fee, set at registration.
  console.log('Building Flight builder registration instruction...');
  const registerBuilderIx = await flight.buildRegisterBuilderIx({
    traderAuthority: builderAuthority,
    traderPdaIndex: args.pdaIndex,
    traderSubaccountIndex: args.subaccountIndex,
    feeBps: BigInt(args.feeBps),
  });
  instructions.push(registerBuilderIx);

  // 8 & 9. Submit and confirm
  console.log('\nSubmitting registration transaction...');
  const tx = new Transaction();
  for (const ix of instructions) {
    // See src/exchange/phoenix/flight.client.ts header: instruction-type
    // compatibility with @solana/web3.js is assumed, not independently
    // verified. If this line errors on a type mismatch, that's the fix.
    tx.add(ix as never);
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [builderKeypair], {
    commitment: 'confirmed',
  });

  // 10. Print results
  console.log('\n=== Registration complete ===');
  console.log(`Builder authority:   ${builderAuthority}`);
  console.log(`Trader PDA index:    ${args.pdaIndex}`);
  console.log(`Subaccount index:    ${args.subaccountIndex}`);
  console.log(`Fee (bps):           ${args.feeBps}`);
  console.log(`Transaction:         ${signature}`);
  console.log(`Explorer:            ${explorerLink(signature)}`);
  console.log(
    "\nNext step: set TRADEPILOT_BUILDER_AUTHORITY in your bot's .env to the builder authority above, " +
      'then restart the bot. Verify the registration also shows up at https://flight.phoenix.trade before enabling public trading.',
  );
}

main().catch((error) => {
  console.error('\nRegistration failed:', error);
  process.exit(1);
});
