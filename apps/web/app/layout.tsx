// T2 owns this file. T0 placeholder.
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "FDE 训练场", description: "可以翻车的客户现场" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
