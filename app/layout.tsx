import type { Metadata, Viewport } from 'next'
import { I18nProvider } from '@/components/i18n-provider'
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
  title: 'Handle — Chat by username',
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
    ],
    apple: `${publicBasePath}/apple-icon.png`,
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfdfc' },
    { media: '(prefers-color-scheme: dark)', color: '#111a1d' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" dir="ltr">
      <body className="antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  )
}
