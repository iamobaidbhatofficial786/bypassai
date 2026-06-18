/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  turbopack: {
    // Ensure Turbopack can resolve the project root correctly
    root: process.cwd(),
  },
};

export default nextConfig;
