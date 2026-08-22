// app/layout.tsx
// Uygulamanın kök layout'u. Tek sayfa olduğu için minimal.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sözleşme Risk Tarayıcısı",
  description: "OpenAI destekli, öğrenme amaçlı sözleşme risk analizi.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
