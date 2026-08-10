import { z } from 'zod';
import { MAX_LEVERAGE_HARD_CAP, MIN_LEVERAGE } from '../constants';

export const marketSymbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}-PERP$/, 'Market must look like "SOL-PERP".');

export const usdAmountSchema = z
  .number({ invalid_type_error: 'Must be a number.' })
  .positive('Amount must be greater than 0.')
  .finite();

export const leverageSchema = z
  .number({ invalid_type_error: 'Leverage must be a number.' })
  .min(MIN_LEVERAGE, `Leverage must be at least ${MIN_LEVERAGE}x.`)
  .max(MAX_LEVERAGE_HARD_CAP, `Leverage cannot exceed ${MAX_LEVERAGE_HARD_CAP}x.`);

export const percentSchema = z
  .number({ invalid_type_error: 'Percentage must be a number.' })
  .min(1, 'Percentage must be at least 1.')
  .max(100, 'Percentage cannot exceed 100.');

export const priceSchema = z
  .number({ invalid_type_error: 'Price must be a number.' })
  .positive('Price must be greater than 0.');

export const base58PrivateKeySchema = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{80,100}$/, 'That does not look like a valid base58 private key.');

export const slippageBpsSchema = z
  .number({ invalid_type_error: 'Slippage must be a number.' })
  .min(1, 'Slippage must be at least 1 basis point.')
  .max(5000, 'Slippage cannot exceed 5000 basis points (50%).');

/**
 * Parses a raw text field against a schema and returns either the parsed
 * value or a single human-readable error string - convenient for wizard
 * steps that just need to show the first validation failure inline.
 */
export function parseOrError<T>(schema: z.ZodSchema<T>, raw: unknown): { value: T } | { error: string } {
  const result = schema.safeParse(raw);
  if (result.success) return { value: result.data };
  return { error: result.error.issues[0]?.message ?? 'Invalid input.' };
}
