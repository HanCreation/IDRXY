import type { MetadataRoute } from 'next';
import { siteDescription, siteName } from './seo';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'IDRXY - Indonesian Rupiah Index',
    short_name: siteName,
    description: siteDescription,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0a0c0f',
    theme_color: '#d2a550',
    icons: [
      {
        src: '/icon.svg',
        sizes: '64x64',
        type: 'image/svg+xml',
      },
      {
        src: '/apple-icon.svg',
        sizes: '180x180',
        type: 'image/svg+xml',
      },
    ],
  };
}
