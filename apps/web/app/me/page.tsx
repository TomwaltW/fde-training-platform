import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { MeClient } from "@/components/me/MeClient";

export const metadata: Metadata = { title: "我的对局" };

export default function MePage() {
  return (
    <>
      <SiteHeader />
      <MeClient />
    </>
  );
}
