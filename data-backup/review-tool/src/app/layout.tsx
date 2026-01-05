import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
    variable: "--font-display",
    subsets: ["latin"],
    display: "swap",
    weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
    variable: "--font-mono",
    subsets: ["latin"],
    display: "swap",
    weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
    title: "Peak Review Tool | PathQuest",
    description: "Review and approve snapped peak coordinates for PathQuest",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${fraunces.variable} ${plexMono.variable}`}
            >
                {children}
            </body>
        </html>
    );
}
