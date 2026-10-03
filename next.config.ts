import type { NextConfig } from "next";

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
]

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || '.next',
  allowedDevOrigins: ['127.0.0.1'],
  compress: false,
  poweredByHeader: false,
  experimental: {
    cpus: Math.max(1, Number(process.env.STOCKBOARD_BUILD_CPUS ?? 2)),
  },
  turbopack: {
    root: process.cwd(),
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
    ]
  },
};

export default nextConfig;
