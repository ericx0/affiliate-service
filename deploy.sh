#!/bin/bash
# Run this AFTER setting env vars in Vercel dashboard
# https://vercel.com/sunoboxs-projects/affiliate-service/settings/environment-variables

set -e
cd "$(dirname "$0")"

echo "=== Required env vars (set in Vercel dashboard first) ==="
cat <<EOT
Production environment:
  NODE_ENV=production
  APP_URL=https://affiliate-service-rho.vercel.app
  WEB_URL=https://linkchinamed.com
  SUPABASE_URL=https://bqjbvnkdhbrkdaraxnvm.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=<from Supabase Dashboard>
  STRIPE_SECRET_KEY=sk_live_...   (or sk_test_ for testing)
  STRIPE_WEBHOOK_SECRET=whsec_...
  LCM_AFFILIATE_SECRET=<32-byte hex, must match main site>
EOT

echo ""
echo "=== Deploying to production ==="
vercel --prod --yes 2>&1 | tail -10

echo ""
echo "=== Health check ==="
sleep 3
curl -s -w "\nHTTP %{http_code}\n" https://affiliate-service-rho.vercel.app/health
