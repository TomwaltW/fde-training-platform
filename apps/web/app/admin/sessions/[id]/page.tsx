import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { AdminSessionClient } from "@/components/admin/AdminSessionClient";
import { decodeParam } from "@/lib/client/format";

export const metadata: Metadata = { title: "对局详情" };

export default async function AdminSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <SiteHeader />
      <AdminSessionClient sessionId={decodeParam(id)} />
    </>
  );
}
