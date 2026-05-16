import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
// Importing the registry here is what causes Next to actually preload
// the curated invitation fonts. The registry's top-level next/font/google
// calls produce <link rel="preload"> tags injected into the document
// head, so by the time the wizard mounts, the fonts are already
// available for both HTML preview AND canvas text rendering.
import "@/lib/fonts/registry";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TheVectorKit — Background Removal & Print-Ready Image Tools",
  description:
    "Remove backgrounds, resize for DTF print at 300 DPI, upscale, and crop your designs. Privacy-first: all processing happens in your browser.",
  keywords: [
    "background removal",
    "DTF",
    "print ready",
    "image editor",
    "transparent background",
    "PNG converter",
    "300 DPI",
  ],
  authors: [{ name: "TheVectorKit" }],
  openGraph: {
    title: "TheVectorKit",
    description:
      "Browser-based image toolkit for designers and DTF print shops. Remove backgrounds, resize, and prep designs for print in seconds.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {children}
        <Toaster richColors position="top-center" />
      </body>
    </html>
  );
}
