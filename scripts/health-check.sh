#!/usr/bin/env bash
# Health check ping for affiliate-service
# Usage: ./scripts/health-check.sh [URL]
URL="${1:-https://affiliate-service-rho.vercel.app}"
RESPONSE=$(curl -s -w "\n%{http_code}" "$URL/health" 2>&1)
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
  echo "OK: $URL/health → 200"
  exit 0
else
  echo "FAIL: $URL/health → $HTTP_CODE"
  echo "$RESPONSE"
  exit 1
fi