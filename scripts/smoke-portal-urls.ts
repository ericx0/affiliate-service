/**
 * Production smoke test for criterion 4: portal-urls split by role.
 *
 * Reads PRODUCTION env from Vercel via `vercel env pull`, runs the same
 * settingsStripeReturnUrl / dashboardUrlFor functions that production
 * server runs, and asserts:
 *   - role=agent → https://agent.linkchinamed.com/...
 *   - role=kol   → https://affiliate.linkchinamed.com/...
 *
 * Usage: cd affiliate-service && vercel env pull --environment=production --yes
 *        npx tsx scripts/smoke-portal-urls.ts
 */
import { settingsStripeReturnUrl, dashboardUrlFor } from "../src/modules/portal-urls.js";

interface Case {
  role: "kol" | "agent";
  label: string;
  expectedBase: string;
}

const CASES: Case[] = [
  { role: "agent", label: "agent Stripe onboarding return URL", expectedBase: "https://agent.linkchinamed.com" },
  { role: "kol", label: "KOL Stripe onboarding return URL", expectedBase: "https://affiliate.linkchinamed.com" },
  { role: "agent", label: "agent commission-paid dashboard link", expectedBase: "https://agent.linkchinamed.com" },
  { role: "kol", label: "KOL commission-paid dashboard link", expectedBase: "https://affiliate.linkchinamed.com" },
];

function run() {
  console.log("=== Production smoke test: criterion 4 (portal-urls by role) ===\n");
  console.log(`PORTAL_URL         = ${process.env.PORTAL_URL ?? "(not set)"}`);
  console.log(`AGENT_PORTAL_URL   = ${process.env.AGENT_PORTAL_URL ?? "(not set)"}\n`);

  let pass = 0;
  let fail = 0;
  for (const c of CASES) {
    const url = c.role === "agent" || c.label.includes("Stripe")
      ? c.label.includes("Stripe") ? settingsStripeReturnUrl(c.role) : dashboardUrlFor(c.role)
      : dashboardUrlFor(c.role);
    const ok = url.startsWith(c.expectedBase);
    console.log(
      `${ok ? "✅" : "❌"} ${c.label.padEnd(40)} ${c.role.padEnd(6)} → ${url}`,
    );
    if (ok) pass++; else fail++;
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}

run();
