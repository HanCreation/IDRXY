import type { Metadata } from 'next';
import { Analytics } from '@vercel/analytics/next';
import './globals.css';
import { siteDescription, siteName, siteTitle, siteUrl } from './seo';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: siteTitle,
    template: `%s · ${siteName}`,
  },
  description: siteDescription,
  applicationName: siteName,
  authors: [{ name: 'Han', url: 'https://dhans.vercel.app' }],
  creator: 'Han',
  publisher: 'IDRXY',
  keywords: [
    'IDRXY',
    'Indonesian Rupiah Index',
    'Rupiah strength',
    'IDR exchange rate',
    'USD IDR',
    'SGD IDR',
    'CNY IDR',
    'foreign exchange Indonesia',
    'currency index',
  ],
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: '/',
    siteName,
    title: siteTitle,
    description: siteDescription,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary',
    title: siteTitle,
    description: siteDescription,
  },
  category: 'finance',
  icons: {
    icon: '/icon.svg',
    apple: '/apple-icon.svg',
  },
  manifest: '/manifest.webmanifest',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
