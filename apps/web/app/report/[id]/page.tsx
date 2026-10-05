import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { ReportClient } from "@/components/report/ReportClient";
import { decodeParam } from "@/lib/client/format";

export const metadata: Metadata = { title: "复盘" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <SiteHeader />
      <ReportClient sessionId={decodeParam(id)} />
    </>
  );
}
