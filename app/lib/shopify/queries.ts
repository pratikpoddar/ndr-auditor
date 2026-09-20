/**
 * Admin GraphQL documents, kept in source control and versioned with API_VERSION.
 *
 * DAY-1 GATE: every field below must be confirmed against the pinned version's schema before
 * it is trusted. Fulfillment event shape in particular varies across versions. If a field
 * does not exist, remove it here rather than defending against it downstream.
 */

/** Newest-first order page with fulfillments and their event timelines. */
export const ORDERS_PAGE_QUERY = `#graphql
  query AuditOrdersPage($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        paymentGatewayNames
        tags
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentSubtotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount currencyCode } }
        shippingAddress { zip city provinceCode countryCodeV2 }
        refunds(first: 10) { id createdAt }
        lineItems(first: 50) {
          nodes {
            id
            sku
            name
            quantity
            variant { id }
            product { id }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
        fulfillments(first: 20) {
          id
          createdAt
          updatedAt
          status
          displayStatus
          trackingInfo(first: 5) { company number url }
          events(first: 100, sortKey: HAPPENED_AT) {
            nodes { id status happenedAt message city province country }
          }
        }
      }
    }
  }
`;

/** Re-fetch a single fulfillment after a webhook. Webhook payloads are thin; this is truth. */
export const FULFILLMENT_QUERY = `#graphql
  query AuditFulfillment($id: ID!) {
    fulfillment(id: $id) {
      id
      createdAt
      updatedAt
      status
      displayStatus
      trackingInfo(first: 5) { company number url }
      order {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        cancelReason
        displayFinancialStatus
        paymentGatewayNames
        tags
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        totalRefundedSet { shopMoney { amount currencyCode } }
        shippingAddress { zip city provinceCode countryCodeV2 }
        refunds(first: 10) { id createdAt }
        lineItems(first: 50) {
          nodes {
            id sku name quantity
            variant { id }
            product { id }
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
      events(first: 100, sortKey: HAPPENED_AT) {
        nodes { id status happenedAt message city province country }
      }
    }
  }
`;

export const SHOP_QUERY = `#graphql
  query AuditShop {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
      primaryDomain { url }
    }
  }
`;

/**
 * Tracking-company correction. This is the app's ONLY write to Shopify, it is gated behind
 * an explicit merchant confirmation, and it deliberately re-sends the existing number and
 * url so a correction cannot silently drop the AWB.
 */
export const TRACKING_INFO_UPDATE = `#graphql
  mutation AuditTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        trackingInfo(first: 5) { company number url }
      }
      userErrors { field message }
    }
  }
`;
