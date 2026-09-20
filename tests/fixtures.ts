import { STATUS } from "../app/lib/normalize";
import type { EventInput, ShipmentInput, OrderInput, InferenceConfig } from "../app/lib/inference/engine";
import { DEFAULT_CONFIG } from "../app/lib/inference/engine";

export const NOW = new Date("2026-09-15T10:00:00.000Z");

export function cfg(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return { ...DEFAULT_CONFIG, now: NOW, ...overrides };
}

let seq = 0;
export function ev(
  status: keyof typeof STATUS,
  daysAgo: number,
  message?: string | null,
): EventInput {
  seq += 1;
  return {
    id: `e${seq}`,
    status: STATUS[status],
    happenedAt: new Date(NOW.getTime() - daysAgo * 86400_000),
    message: message ?? null,
    city: "Pune",
  };
}

export function shipment(events: EventInput[], currentStatus?: keyof typeof STATUS): ShipmentInput {
  const sorted = [...events].sort((a, b) => a.happenedAt.getTime() - b.happenedAt.getTime());
  const last = sorted[sorted.length - 1];
  return {
    fulfillmentId: "f1",
    currentStatus: currentStatus ? STATUS[currentStatus] : (last?.status ?? STATUS.UNKNOWN),
    firstShippedAt: sorted[0]?.happenedAt ?? null,
    events,
  };
}

export function order(overrides: Partial<OrderInput> = {}): OrderInput {
  return { value: 2400, cancelledAt: null, refundAmount: 0, lastRefundAt: null, ...overrides };
}
