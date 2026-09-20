import type { PrismaClient } from "@prisma/client";
import { claimNext, complete, fail } from "./queue.server";
import { HANDLERS } from "./handlers.server";

/** Process a single job if one is available. Returns false when the queue is idle. */
export async function tick(prisma: PrismaClient): Promise<boolean> {
  const job = await claimNext(prisma);
  if (!job) return false;

  const handler = HANDLERS[job.kind];
  if (!handler) {
    await fail(prisma, job, new Error(`no handler for job kind ${job.kind}`));
    return true;
  }

  try {
    await handler(prisma, job.payload);
    await complete(prisma, job.id);
  } catch (err) {
    // Structured log with shop + job identity, never the payload (it can carry buyer data).
    console.error(JSON.stringify({
      level: "error", msg: "job failed", jobId: job.id, kind: job.kind,
      shopId: job.shopId, attempt: job.attempts,
      error: err instanceof Error ? err.message : String(err),
    }));
    await fail(prisma, job, err);
  }
  return true;
}

export async function runForever(prisma: PrismaClient, idleMs = 1000): Promise<void> {
  console.log(JSON.stringify({ level: "info", msg: "worker started" }));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    let worked = false;
    try {
      worked = await tick(prisma);
    } catch (err) {
      console.error(JSON.stringify({ level: "error", msg: "worker loop error", error: String(err) }));
    }
    if (!worked) await new Promise((r) => setTimeout(r, idleMs));
  }
  console.log(JSON.stringify({ level: "info", msg: "worker stopped" }));
  await prisma.$disconnect();
}
