/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  experimental: {
    // Ensure Turbopack can resolve the project root correctly
    turbopack: {
      root: __dirname,
    },
  },
};

export default nextConfig;
