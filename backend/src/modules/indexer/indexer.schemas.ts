import { z } from "zod";

/**
 * Standard decoded on-chain event representation.
 */
export interface DecodedChainLog {
  txHash: string;
  logIndex: number;
  eventName: string;
  blockNumber: bigint;
  blockTimestamp: bigint;
  args: Record<string, any>;
}

export const IndexerStatusResponseSchema = z.object({
  lastProcessedBlock: z.string(),
  latestOnChainBlock: z.string().optional(),
  lagBlocks: z.string().optional(),
  isSynced: z.boolean(),
  totalIndexedEvents: z.number(),
  lastSyncTimestamp: z.string(),
});

export type IndexerStatusResponse = z.infer<typeof IndexerStatusResponseSchema>;
