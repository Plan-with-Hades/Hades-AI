/**
 * Checks the Pine Labs keys in .env: gets a token and creates a ₹1 checkout link (nothing is charged
 * unless someone opens the link and pays). Run: npm run check:pinelabs
 */
import { createPinelabsOrder, pinelabsConfigured, pinelabsMode } from "../src/payments/pinelabs";

if (!pinelabsConfigured()) {
  console.error("PINELABS_CLIENT_ID / PINELABS_CLIENT_SECRET are empty in .env");
  process.exit(1);
}
console.log(`Pine Labs mode: ${pinelabsMode()}`);
const order = await createPinelabsOrder({
  reference: `hades-check-${Date.now()}`,
  amountPaise: 100,
  callbackUrl: "https://hades-api-zt6n.onrender.com/api/payments/pinelabs/callback",
  failureCallbackUrl: "https://hades-api-zt6n.onrender.com/api/payments/pinelabs/failure",
  customer: { firstName: "Hades check" },
});
console.log("OK: token and order work.", { orderId: order.orderId, status: order.status, checkoutUrl: order.checkoutUrl });
