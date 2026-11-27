import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      workbox: {
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,css,html,ico,png,svg}"],
        // 선수 사진(Supabase 파일 저장소): 한 번 받으면 기기에 보관 → 다음부터 바로 표시
        // (사진 주소는 바뀔 때마다 새 이름이라 오래 보관해도 안전)
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes("/storage/v1/object/public/player-photos/"),
            handler: "CacheFirst",
            options: {
              cacheName: "player-photos",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // 필요하면 배포 환경에서만 켜기
      // disable: process.env.VITE_PWA !== "true",
      manifest: {
        name: "Goldin Futsal",
        short_name: "Goldin",
        start_url: "/",
        display: "standalone",
        background_color: "#111111",
        theme_color: "#111111",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-512x512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable any" },
        ],
      },
    }),
  ],
});
