-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "scopes" TEXT,
    "apiVersion" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'founding',
    "auditWindowDays" INTEGER NOT NULL DEFAULT 90,
    "codGatewayRules" TEXT[] DEFAULT ARRAY['cash on delivery (cod)', 'cod', 'cash_on_delivery', 'manual']::TEXT[],
    "riskValueBasis" TEXT NOT NULL DEFAULT 'ORDER_VALUE',
    "staleOfdHours" INTEGER NOT NULL DEFAULT 36,
    "staleNoEventDays" INTEGER NOT NULL DEFAULT 10,
    "whatsappConfig" JSONB,
    "quietHoursStart" INTEGER NOT NULL DEFAULT 21,
    "quietHoursEnd" INTEGER NOT NULL DEFAULT 8,
    "backfillState" TEXT NOT NULL DEFAULT 'PENDING',
    "backfillCursor" TEXT,
    "backfillCoverageFrom" TIMESTAMP(3),
    "backfillOrdersSeen" INTEGER NOT NULL DEFAULT 0,
    "hasReadAllOrders" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFact" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentMode" TEXT NOT NULL,
    "gatewayNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pincode" TEXT,
    "pincodePrefix" TEXT,
    "city" TEXT,
    "provinceCode" TEXT,
    "countryCode" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "financialStatus" TEXT,
    "refundAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lastRefundAt" TIMESTAMP(3),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "OrderFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemFact" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "attributableValue" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "OrderItemFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fulfillmentId" TEXT NOT NULL,
    "carrierRaw" TEXT,
    "carrierNormalized" TEXT,
    "awb" TEXT,
    "trackingUrl" TEXT,
    "currentStatus" TEXT NOT NULL,
    "rawStatus" TEXT,
    "firstShippedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "trackable" BOOLEAN NOT NULL DEFAULT false,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rawStatus" TEXT,
    "happenedAt" TIMESTAMP(3) NOT NULL,
    "city" TEXT,
    "province" TEXT,
    "message" TEXT,
    "ingestionSource" TEXT NOT NULL DEFAULT 'SHOPIFY',

    CONSTRAINT "ShipmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NDRIncident" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "triggerEventId" TEXT,
    "openRule" TEXT NOT NULL,
    "reasonClass" TEXT NOT NULL,
    "reasonEvidence" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBand" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NDR_OPEN',
    "rtoLevel" TEXT NOT NULL DEFAULT 'NONE',
    "rtoRule" TEXT,
    "riskValue" DECIMAL(14,2) NOT NULL,
    "actionDueAt" TIMESTAMP(3),
    "recomputedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveryTokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "contactedAt" TIMESTAMP(3),
    "buyerIntent" TEXT,

    CONSTRAINT "NDRIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerResponse" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "respondedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientHash" TEXT,

    CONSTRAINT "BuyerResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryOutcome" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "outcomeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evidenceType" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "finalStatus" TEXT,
    "realizedValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "RecoveryOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT,
    "providerResponse" JSONB,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierScorecard" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "carrier" TEXT NOT NULL,
    "shipped" INTEGER NOT NULL,
    "trackable" INTEGER NOT NULL,
    "attempted" INTEGER NOT NULL,
    "failed" INTEGER NOT NULL,
    "inferredRtoHigh" INTEGER NOT NULL,
    "inferredRtoMedium" INTEGER NOT NULL,
    "delivered" INTEGER NOT NULL,
    "medianDeliveryDays" DOUBLE PRECISION,
    "valueAtRisk" DECIMAL(14,2) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierScorecard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingHygieneReport" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "totalFulfillments" INTEGER NOT NULL,
    "missingAwb" INTEGER NOT NULL,
    "missingCarrier" INTEGER NOT NULL,
    "unrecognizedCarrier" INTEGER NOT NULL,
    "duplicateAwb" INTEGER NOT NULL,
    "invalidUrl" INTEGER NOT NULL,
    "staleTracking" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackingHygieneReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawPayload" TEXT,
    "purgeAfter" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyWriteLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "mutation" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "beforeValue" JSONB NOT NULL,
    "afterValue" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "succeeded" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyWriteLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Shop_domain_idx" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "OrderFact_shopId_createdAt_idx" ON "OrderFact"("shopId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFact_shopId_shopifyOrderId_key" ON "OrderFact"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "OrderItemFact_orderId_idx" ON "OrderItemFact"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemFact_orderId_lineItemId_key" ON "OrderItemFact"("orderId", "lineItemId");

-- CreateIndex
CREATE INDEX "Shipment_shopId_currentStatus_idx" ON "Shipment"("shopId", "currentStatus");

-- CreateIndex
CREATE INDEX "Shipment_shopId_carrierNormalized_idx" ON "Shipment"("shopId", "carrierNormalized");

-- CreateIndex
CREATE INDEX "Shipment_shopId_awb_idx" ON "Shipment"("shopId", "awb");

-- CreateIndex
CREATE UNIQUE INDEX "Shipment_shopId_fulfillmentId_key" ON "Shipment"("shopId", "fulfillmentId");

-- CreateIndex
CREATE INDEX "ShipmentEvent_shipmentId_happenedAt_idx" ON "ShipmentEvent"("shipmentId", "happenedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentEvent_shipmentId_sourceEventId_key" ON "ShipmentEvent"("shipmentId", "sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "NDRIncident_recoveryTokenHash_key" ON "NDRIncident"("recoveryTokenHash");

-- CreateIndex
CREATE INDEX "NDRIncident_shopId_state_idx" ON "NDRIncident"("shopId", "state");

-- CreateIndex
CREATE INDEX "NDRIncident_shopId_openedAt_idx" ON "NDRIncident"("shopId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "NDRIncident_shipmentId_openedAt_key" ON "NDRIncident"("shipmentId", "openedAt");

-- CreateIndex
CREATE INDEX "BuyerResponse_incidentId_idx" ON "BuyerResponse"("incidentId");

-- CreateIndex
CREATE INDEX "RecoveryOutcome_incidentId_idx" ON "RecoveryOutcome"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertLog_dedupeKey_key" ON "AlertLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "AlertLog_incidentId_idx" ON "AlertLog"("incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierScorecard_shopId_windowStart_windowEnd_carrier_key" ON "CourierScorecard"("shopId", "windowStart", "windowEnd", "carrier");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingHygieneReport_shopId_windowStart_windowEnd_key" ON "TrackingHygieneReport"("shopId", "windowStart", "windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "Job_state_runAfter_idx" ON "Job"("state", "runAfter");

-- CreateIndex
CREATE INDEX "Job_shopId_kind_idx" ON "Job"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_webhookId_key" ON "WebhookReceipt"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_purgeAfter_idx" ON "WebhookReceipt"("purgeAfter");

-- CreateIndex
CREATE INDEX "ShopifyWriteLog_shopId_createdAt_idx" ON "ShopifyWriteLog"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderFact" ADD CONSTRAINT "OrderFact_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemFact" ADD CONSTRAINT "OrderItemFact_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "OrderFact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentEvent" ADD CONSTRAINT "ShipmentEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NDRIncident" ADD CONSTRAINT "NDRIncident_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NDRIncident" ADD CONSTRAINT "NDRIncident_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerResponse" ADD CONSTRAINT "BuyerResponse_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "NDRIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryOutcome" ADD CONSTRAINT "RecoveryOutcome_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "NDRIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertLog" ADD CONSTRAINT "AlertLog_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "NDRIncident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierScorecard" ADD CONSTRAINT "CourierScorecard_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingHygieneReport" ADD CONSTRAINT "TrackingHygieneReport_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyWriteLog" ADD CONSTRAINT "ShopifyWriteLog_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

