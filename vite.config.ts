import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // ponytail: relative base so Pages works under any repo name
  base: "./",
  plugins: [react(), tailwindcss()],
});
