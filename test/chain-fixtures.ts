// Consistent public-chain metadata for fake RPC responses. These are not actual chain observations.
export const canonicalBlockHash = (block: number): `0x${string}` => `0x${(BigInt(block) + 1n).toString(16).padStart(64, "0")}`;
export const canonicalBlock = (block: number) => ({ number: `0x${block.toString(16)}`, hash: canonicalBlockHash(block) });
export const minedTransaction = (hash: string, block: number) => ({ hash, blockNumber: `0x${block.toString(16)}`, blockHash: canonicalBlockHash(block) });
export const minedReceipt = (hash: string, block: number) => ({ transactionHash: hash, blockNumber: `0x${block.toString(16)}`, blockHash: canonicalBlockHash(block) });
