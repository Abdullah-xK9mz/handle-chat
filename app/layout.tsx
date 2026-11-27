import type { Metadata, Viewport } from 'next'
import { I18nProvider } from '@/components/i18n-provider'
import { PreventPullToRefresh } from '@/components/prevent-pull-to-refresh'
import './globals.css'

const repositoryParts = process.env.GITHUB_REPOSITORY?.split('/')
const isUserSite =
  repositoryParts?.[1]?.toLowerCase() ===
  `${repositoryParts?.[0]?.toLowerCase()}.github.io`
const publicBasePath =
  process.env.GITHUB_ACTIONS === 'true' && repositoryParts?.[1] && !isUserSite
    ? `/${repositoryParts[1]}`
    : ''

export const metadata: Metadata = {
  title: 'Message — Chat by username',
  description:
    'A private messaging app where people find each other by username, not phone number.',
  generator: 'v0.app',
  icons: {
    icon: [
      {
        url: `${publicBasePath}/icon-light-32x32.png`,
        media: '(prefers-color-scheme: light)',
      },
      {
        url: `${publicBasePath}/icon-dark-32x32.png`,
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: `${publicBasePath}/icon.svg`,
        type: 'image/svg+xml',
      },
      {
        url: `${publicBasePath}/icon-512.png`,
        type: 'image/png',
        sizes: '512x512',
      },
    ],
    apple: `${publicBasePath}/apple-icon.png`,
  },
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  themeColor: '#11100e',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" dir="ltr" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <PreventPullToRefresh />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  )
}

