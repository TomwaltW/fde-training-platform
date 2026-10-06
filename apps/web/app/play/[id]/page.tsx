import type { Metadata } from "next";
import { PlayClient } from "@/components/play/PlayClient";
import { decodeParam } from "@/lib/client/format";

export const metadata: Metadata = { title: "对局" };

export default async function PlayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlayClient sessionId={decodeParam(id)} />;
}
