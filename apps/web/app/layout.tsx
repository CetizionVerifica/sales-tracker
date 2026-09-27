import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/layout/ThemeProvider';
import { Toaster } from '@/components/ui/sonner';
import './globals.css';

// The app's one typeface (UI guide §1), exposed as --font-plex for Tailwind's font-sans.
// Self-hosted (latin, 400/500/600; SIL OFL, see fonts/OFL.txt): next/font/google fails
// under this Next version's Turbopack when more than one weight is requested.
const plex = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sales Tracker',
  description: 'Enquiry → Quotation → Project → Purchase Order → Invoice',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // next-themes sets the class on <html> before hydration.
    <html lang="en" className={plex.variable} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <ThemeProvider>
          {children}
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
