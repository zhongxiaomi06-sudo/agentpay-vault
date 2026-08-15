import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
};

const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";
const isStandalone = process.env.NEXT_PUBLIC_STANDALONE_BUILD === "true";

if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}

// 国内直连镜像：standalone 自包含 Node 服务（scp 到自有服务器跑，nginx 挂 /agentpay 子路径）
if (isStandalone) {
  nextConfig.output = "standalone";
  nextConfig.outputFileTracingRoot = new URL("../../", import.meta.url).pathname;
  nextConfig.basePath = "/agentpay";
}

module.exports = nextConfig;
