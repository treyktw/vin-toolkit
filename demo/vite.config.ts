import { defineConfig } from "vite";

// getUserMedia needs a secure context: http://localhost counts, a LAN IP does not.
// To test on a phone, run `pnpm dev --host` behind an HTTPS tunnel.
export default defineConfig({
  server: { port: 5173 },
});
