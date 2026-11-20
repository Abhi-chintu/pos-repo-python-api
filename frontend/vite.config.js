import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/auth": "http://127.0.0.1:8001",
      "/api/users": "http://127.0.0.1:8001",
      "/api/products": "http://127.0.0.1:8002",
      "/api/orders": "http://127.0.0.1:8003",
      "/api/kitchen": "http://127.0.0.1:8004",
    },
  },
  test: {
    environment: "jsdom",
    restoreMocks: true,
  },
});

