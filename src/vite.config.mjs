import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const { loadSelectedDistribution } = require("./config/distributionSchema.ts");
const DEFAULT_DEV_SERVER_PORT = 5183;

const parseDevServerPort = (rawPort) => {
  const normalizedPort = rawPort || String(DEFAULT_DEV_SERVER_PORT);
  const parsedPort = Number(normalizedPort);

  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return DEFAULT_DEV_SERVER_PORT;
  }

  return parsedPort;
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, "..");
  const env = loadEnv(mode, envDir, "");
  const distribution = loadSelectedDistribution({ ...process.env, ...env }, envDir);
  const rawPort = env.VITE_DEV_SERVER_PORT || env.OPENWHISPR_DEV_SERVER_PORT;
  const devServerPort = parseDevServerPort(rawPort);

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "distribution-branding",
        transformIndexHtml(html) {
          return html.replace(/<title>.*?<\/title>/, `<title>${distribution.productName}</title>`);
        },
      },
      {
        name: "write-runtime-env",
        writeBundle() {
          const runtimeEnv = {
            VITE_OPENWHISPR_API_URL: env.VITE_OPENWHISPR_API_URL || distribution.services.apiUrl,
            VITE_AUTH_URL: env.VITE_AUTH_URL || distribution.services.authUrl,
          };
          fs.writeFileSync(
            path.resolve(__dirname, "dist", "runtime-env.json"),
            JSON.stringify(runtimeEnv)
          );
        },
      },
    ],
    base: "./", // Use relative paths for file:// protocol in Electron
    define: {
      __APP_DISTRIBUTION__: JSON.stringify(distribution),
    },
    envDir, // Load .env from project root
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        "@distribution/logo": path.resolve(envDir, distribution.assets.rendererLogo),
        "@distribution/icon": path.resolve(envDir, distribution.assets.rendererIcon),
        // Optional: a distribution that wants its own onboarding glyph points
        // this at an image; the default distribution maps it to an empty
        // module so the built-in SVG keeps rendering.
        "@distribution/mark": distribution.assets.onboardingMark
          ? path.resolve(envDir, distribution.assets.onboardingMark)
          : path.resolve(__dirname, "config/emptyDistributionMark.ts"),
      },
    },
    server: {
      port: devServerPort,
      strictPort: true,
      host: "127.0.0.1",
    },
    build: {
      outDir: "dist",
      assetsDir: "assets",
      rolldownOptions: {
        external: [
          "electron",
          "fs",
          "path",
          "child_process",
          "https",
          "http",
          "crypto",
          "os",
          "stream",
          "util",
          "zlib",
          "tar",
          "unzipper",
          "@aws-sdk/client-s3",
        ],
        output: {
          manualChunks(id) {
            if (
              id.includes("@radix-ui/react-dialog") ||
              id.includes("@radix-ui/react-dropdown-menu") ||
              id.includes("@radix-ui/react-select") ||
              id.includes("@radix-ui/react-tabs")
            ) {
              return "vendor-radix";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
          },
        },
      },
    },
  };
});
