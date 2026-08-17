import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { toWeb3Instruction } from './flight.client';

describe('toWeb3Instruction', () => {
  it('converts a Solana Kit instruction into the shape required by web3.js', () => {
    const programAddress = PublicKey.unique().toBase58();
    const readonly = PublicKey.unique().toBase58();
    const writableSigner = PublicKey.unique().toBase58();

    const instruction = toWeb3Instruction({
      programAddress,
      accounts: [
        { address: readonly, role: 0 },
        { address: writableSigner, role: 3 },
      ],
      data: new Uint8Array([1, 2, 3]),
    });

    expect(instruction.programId.toBase58()).toBe(programAddress);
    expect(instruction.keys).toEqual([
      expect.objectContaining({ pubkey: new PublicKey(readonly), isSigner: false, isWritable: false }),
      expect.objectContaining({ pubkey: new PublicKey(writableSigner), isSigner: true, isWritable: true }),
    ]);
    expect([...instruction.data]).toEqual([1, 2, 3]);
  });

  it('rejects an instruction without a program address before sending', () => {
    expect(() => toWeb3Instruction({ programAddress: '', accounts: [], data: new Uint8Array() })).toThrow(/program address/i);
  });
});
