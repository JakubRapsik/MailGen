import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    // server: {
    //     proxy: {
    //         // forward /api requests to the local proxy server running on port 3000
    //         "/api": {
    //             target: "http://localhost:3000",
    //             changeOrigin: true,
    //             secure: false,
    //         },
    //     },
    // },
});
