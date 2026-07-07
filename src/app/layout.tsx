import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--font-schibsted",
});
const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
});

export const metadata: Metadata = {
  title: "Pathways — how people actually get there",
  description:
    "Type the role you want. See the real career paths real people took to reach it — grouped into recognizable patterns, with the actual people behind each one.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const contact = process.env.CONTACT_EMAIL ?? "seanmtli@gmail.com";
  return (
    <html lang="en" className={`${schibsted.variable} ${splineMono.variable}`}>
      <body>
        <div style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1 }}>{children}</div>
          <footer
            style={{
              borderTop: "1px solid var(--line)",
              padding: "20px 20px 28px",
              fontSize: 13,
              color: "var(--ink-soft)",
              display: "flex",
              flexWrap: "wrap",
              gap: "6px 24px",
              justifyContent: "center",
              textAlign: "center",
            }}
          >
            <span style={{ maxWidth: "58ch" }}>
              Career data sourced from public professional profiles via our data
              provider. To request removal, contact{" "}
              <a href={`mailto:${contact}`}>{contact}</a>.
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
