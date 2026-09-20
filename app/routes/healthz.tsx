import prisma from "../db.server";

/**
 * Liveness + readiness probe.
 *
 * Checks the database, because a web process that cannot reach Postgres is useless even
 * though it still serves HTML. Deliberately exposes no shop data, no counts and no version
 * details — it is an unauthenticated endpoint on a public domain.
 */
export async function loader() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return new Response(JSON.stringify({ status: "degraded" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
}
