import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Pine Labs Online hosted checkout (no card data touches our servers).
 * Flow: token → create order (returns checkout_url) → customer pays on Pine Labs →
 * redirect to our callback with order_id, payment_status and an HMAC-SHA256 signature.
 * Docs: https://www.pinelabs.com/docs/online-payments/use-cases/accept-payments-startup
 *
 * Without credentials the API falls back to a clearly labelled simulated checkout,
 * so the product flow can be demoed before UAT keys arrive.
 */
const ENV = (process.env.PINELABS_ENV ?? "uat").toLowerCase();
const BASE = process.env.PINELABS_BASE_URL ?? (ENV === "prod" ? "https://api.pluralonline.com" : "https://pluraluat.v2.pinepg.in");
const CLIENT_ID = process.env.PINELABS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.PINELABS_CLIENT_SECRET ?? "";
/** Secret used to verify redirect signatures. Defaults to the client secret. */
const SIGNING_SECRET = process.env.PINELABS_SIGNING_SECRET ?? CLIENT_SECRET;

export const pinelabsConfigured = () => !!(CLIENT_ID && CLIENT_SECRET);
export const pinelabsMode = () => (pinelabsConfigured() ? (ENV === "prod" ? "live" : "test") : "simulated");

let cached: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${BASE}/api/auth/v1/token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "client_credentials" }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number; message?: string };
  if (!res.ok || !json.access_token) throw new Error(`Pine Labs token failed (${res.status}): ${json.message ?? JSON.stringify(json)}`);
  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export interface CreateOrderInput {
  reference: string;
  amountPaise: number;
  callbackUrl: string;
  failureCallbackUrl: string;
  customer?: { email?: string; firstName?: string; mobile?: string };
}

export async function createPinelabsOrder(input: CreateOrderInput): Promise<{ orderId: string; checkoutUrl: string; status: string }> {
  const res = await fetch(`${BASE}/api/pay/v1/orders`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await token()}`,
      "content-type": "application/json",
      accept: "application/json",
      "Request-ID": randomUUID(),
      "Request-Timestamp": new Date().toISOString(),
    },
    body: JSON.stringify({
      merchant_order_reference: input.reference,
      order_amount: { value: input.amountPaise, currency: "INR" },
      pre_auth: false,
      allowed_payment_methods: ["UPI", "CARD", "NETBANKING", "WALLET"],
      callback_url: input.callbackUrl,
      failure_callback_url: input.failureCallbackUrl,
      purchase_details: {
        customer: {
          email_id: input.customer?.email,
          first_name: input.customer?.firstName,
          mobile_number: input.customer?.mobile,
          country_code: "91",
        },
      },
    }),
  });
  const json = (await res.json()) as any;
  const data = json?.data ?? json;
  const orderId = data?.order_id;
  const checkoutUrl = data?.checkout_url ?? data?.redirect_url;
  if (!res.ok || !orderId || !checkoutUrl) throw new Error(`Pine Labs order failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  return { orderId, checkoutUrl, status: data?.status ?? "CREATED" };
}

/** Verifies `order_id=<id>&status=<status>` signed with HMAC-SHA256. Accepts hex or base64 encodings. */
export function verifyPinelabsSignature(orderId: string, status: string, signature: string | undefined): boolean {
  if (!signature || !SIGNING_SECRET) return false;
  const mac = createHmac("sha256", SIGNING_SECRET).update(`order_id=${orderId}&status=${status}`).digest();
  for (const expected of [mac.toString("hex"), mac.toString("base64")]) {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
