import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @imgly/background-removal ships WASM and ONNX assets that need to be
  // served as-is from the browser. Allow them through with permissive headers.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
