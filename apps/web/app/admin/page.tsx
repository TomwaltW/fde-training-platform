import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { AdminClient } from "@/components/admin/AdminClient";

export const metadata: Metadata = { title: "管理" };

export default function AdminPage() {
  return (
    <>
      <SiteHeader />
      <AdminClient />
    </>
  );
}
