import { Suspense } from "react";
import { VendorClient } from "./vendor-client";

async function Vendor({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <VendorClient token={token} />;
}

export default function VendorPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-bg" />}>
      <Vendor params={params} />
    </Suspense>
  );
}
