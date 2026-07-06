# affiliate-service

LinkChinaMed KOL affiliate program backend.

## Architecture

Independent Node.js/Express + TypeScript service, sharing Supabase DB (schema `affiliate`) with main-site. All admin operations go through this service; `service_role` key is never exposed to front-end.

## Local development

```bash
npm install
cp .env.example .env
# fill in real values
npm run dev
```

## Testing

```bash
npm test
```

## Deployment

Deployed to Vercel as a Node.js project. Env vars set in Vercel dashboard.

## Endpoints

- `POST /api/affiliate/orders/attach` — bind order to promoter
- `POST /api/affiliate/events/order-paid` — order paid
- `POST /api/affiliate/events/order-completed` — order completed (start cool-down)
- `POST /api/affiliate/events/order-refunded` — refund (deduct commission)
- `GET  /api/affiliate/orders/:orderId/promoter` — query order's promoter

All requests require `X-LCM-Signature: sha256=<hex>` header.