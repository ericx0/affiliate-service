import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      PORT: "3001",
      APP_URL: "http://localhost:3001",
      WEB_URL: "http://localhost:3000",
      SUPABASE_URL: "https://placeholder.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "placeholder-key-for-test",
      STRIPE_SECRET_KEY: "sk_test_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
      LCM_AFFILIATE_SECRET: "test-secret-32-chars-long-xxxxxx",
      LOG_LEVEL: "warn",
    },
  },
});
