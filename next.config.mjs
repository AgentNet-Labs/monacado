/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the workspace root: a stray lockfile in a parent directory would
  // otherwise cause Next to infer the wrong root for file tracing.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
