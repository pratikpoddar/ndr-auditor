import type { PrismaClient } from "@prisma/client";

/**
 * Database-backed durable queue.
 *
 * The spec allowed BullMQ+Redis or a database queue "if hosting simplicity wins". For a solo
 * build with a live install-to-audit demo, it wins: one less managed service to provision,
 * one less thing that can be down on stage, and jobs survive a restart because they were
 * never only in memory. Throughput is far below anything Postgres would struggle with at
 * 10k shipments/month. Revisit if a shop pushes sustained webhook volume.
 */

export type JobKind = "BACKFILL_PAGE" | "NORMALIZE_FULFILLMENT" | "RECOMPUTE" | "SEND_ALERT";

export async function enqueue(
  prisma: PrismaClient,
  kind: JobKind,
  payload: Record<string, unknown>,
  opts: { shopId?: string; dedupeKey?: string; runAfter?: Date; maxAttempts?: number } = {},
): Promise<{ enqueued: boolean; id: string | null }> {
  // A dedupeKey makes enqueueing idempotent, which is how duplicate Shopify webhook
  // deliveries end up doing work exactly once.
  if (opts.dedupeKey) {
    const existing = await prisma.job.findUnique({ where: { dedupeKey: opts.dedupeKey } });
    if (existing) return { enqueued: false, id: existing.id };
  }
  try {
    const job = await prisma.job.create({
      data: {
        kind,
        payload: payload as any,
        shopId: opts.shopId ?? null,
        dedupeKey: opts.dedupeKey ?? null,
        runAfter: opts.runAfter ?? new Date(),
        maxAttempts: opts.maxAttempts ?? 5,
      },
    });
    return { enqueued: true, id: job.id };
  } catch (err: any) {
    // Unique violation = another request enqueued the same dedupeKey concurrently.
    if (err?.code === "P2002") return { enqueued: false, id: null };
    throw err;
  }
}

/**
 * Claim one job atomically. `updateMany` with a state guard is the lock: two workers racing
 * on the same row produce one winner (count 1) and one loser (count 0).
 */
export async function claimNext(prisma: PrismaClient): Promise<any | null> {
  const candidates = await prisma.job.findMany({
    where: { state: "QUEUED", runAfter: { lte: new Date() } },
    orderBy: { runAfter: "asc" },
    take: 10,
  });

  for (const c of candidates) {
    const claimed = await prisma.job.updateMany({
      where: { id: c.id, state: "QUEUED" },
      data: { state: "RUNNING", attempts: { increment: 1 } },
    });
    if (claimed.count === 1) {
      return prisma.job.findUnique({ where: { id: c.id } });
    }
  }
  return null;
}

export async function complete(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.job.update({ where: { id }, data: { state: "DONE", lastError: null } });
}

/** Capped exponential backoff: 2s, 4s, 8s ... up to 5 minutes. */
export async function fail(prisma: PrismaClient, job: { id: string; attempts: number; maxAttempts: number }, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delayMs = Math.min(2 ** job.attempts * 1000, 300_000);
  await prisma.job.update({
    where: { id: job.id },
    data: {
      state: exhausted ? "FAILED" : "QUEUED",
      lastError: message.slice(0, 1000),
      runAfter: new Date(Date.now() + delayMs),
    },
  });
}
