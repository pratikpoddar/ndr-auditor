import { PrismaClient } from "@prisma/client";
import { runForever } from "./runner.server";

// Standalone worker process: `npm run worker`. Deployed separately from the web app so
// backfill pressure never slows a webhook acknowledgement.
await runForever(new PrismaClient());
