import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  async rewrites() {
    // 前端只通过 /api 与后端通信（Harness 隔离在后端 Adapter 之后）
    const apiBase = process.env["READYWORK_API_BASE_URL"] ?? "http://127.0.0.1:4173";
    // Editor/Rules 属于 P2 控制面，独立进程升级与回滚，不影响现有采购业务面。
    const controlPlaneBase = process.env["READYWORK_CONTROL_PLANE_BASE_URL"] ?? "http://127.0.0.1:4174";
    return [
      { source: "/api/editor/:path*", destination: `${controlPlaneBase}/api/editor/:path*` },
      { source: "/api/operations/:path*", destination: `${controlPlaneBase}/api/operations/:path*` },
      { source: "/api/collaboration/teams/bindings", destination: `${controlPlaneBase}/api/collaboration/teams/bindings` },
      { source: "/api/rules/:path*", destination: `${controlPlaneBase}/api/rules/:path*` },
      { source: "/api/rules", destination: `${controlPlaneBase}/api/rules` },
      { source: "/api/catalog", destination: `${controlPlaneBase}/api/catalog` },
      { source: "/api/employee-packs", destination: `${controlPlaneBase}/api/employee-packs` },
      { source: "/api/employee-packs/:path*", destination: `${controlPlaneBase}/api/employee-packs/:path*` },
      { source: "/api/employees", destination: `${controlPlaneBase}/api/employees` },
      { source: "/api/employees/:path*", destination: `${controlPlaneBase}/api/employees/:path*` },
      { source: "/api/:path*", destination: `${apiBase}/api/:path*` },
    ];
  },
};

export default nextConfig;
