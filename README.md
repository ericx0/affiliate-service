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

### KOL self-service (JWT-authenticated)

- `GET   /api/affiliate/me/analytics?days=7|30|90` — dashboard analytics (clicks, signups, orders, commission, trend, breakdowns)
- `GET   /api/affiliate/me/tax-docs` — 1099-NEC / year-end summary PDFs (5 yrs, pending until tax service integrated)
- `GET   /api/affiliate/me/commission-projection?days=30` — forecasted 30-day commission
- `GET   /api/affiliate/clients` — list / filter the KOL's clients
- `POST  /api/affiliate/clients` — register a client (`consent_verified=true` required); auto-creates 4 SOP followup tasks (Day 0/1/3/7) via SQL trigger
- `GET   /api/affiliate/clients/:id` — fetch one client (404 for cross-KOL)
- `PATCH /api/affiliate/clients/:id` — update fields (404 for cross-KOL)
- `POST  /api/affiliate/clients/:id/contacts` — log a contact touch; returns `suggestions: null` if `OPENAI_API_KEY` is unset
- `POST  /api/affiliate/tasks/:id/complete` — complete a followup task (404 for cross-KOL)