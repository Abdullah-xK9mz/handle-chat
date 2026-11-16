/** @type {import('next').NextConfig} */
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const repositoryOwner = process.env.GITHUB_REPOSITORY?.split('/')[0]
const isUserSite =
  repositoryName?.toLowerCase() === `${repositoryOwner?.toLowerCase()}.github.io`
const basePath =
  process.env.GITHUB_ACTIONS === 'true' && repositoryName && !isUserSite
    ? `/${repositoryName}`
    : ''

const nextConfig = {
  output: 'export',
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
}

export default nextConfig

