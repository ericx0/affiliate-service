// One-off script: create admin user via Supabase service_role
//
// S1 fix: admin email + password now come from .env (ADMIN_EMAIL,
// ADMIN_PASSWORD) so this script no longer ships plaintext credentials.
// First-time setup:
//
//   1. Add to .env (or .env.local) at the project root:
//        ADMIN_EMAIL=admin2026@linkchinamed.com
//        ADMIN_PASSWORD=<a strong random password you generate>
//   2. node create-admin.mjs
//
// For environments that already have the admin user provisioned
// (e.g. production), this script only resets the password to the
// value in ADMIN_PASSWORD — it does not rotate the email.
//
// SECURITY: never commit a populated ADMIN_PASSWORD to git.
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first");
  process.exit(1);
}

const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!EMAIL || !PASSWORD) {
  console.error(
    "Set ADMIN_EMAIL and ADMIN_PASSWORD in .env (or .env.local) before running.\n" +
      "Generate a strong random password with: openssl rand -base64 32"
  );
  process.exit(1);
}

// 1. Check if user already exists
const { data: existing } = await sb.auth.admin.listUsers();
let user = existing?.users?.find((u) => u.email === EMAIL);

if (user) {
  console.log(`User ${EMAIL} already exists: ${user.id}`);
  // Update password to ensure it's correct
  const { error: updErr } = await sb.auth.admin.updateUserById(user.id, { password: PASSWORD });
  if (updErr) {
    console.error("❌ failed to update password:", updErr.message);
    process.exit(1);
  }
  console.log("✅ password updated");
} else {
  const { data, error } = await sb.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) {
    console.error("❌ createUser failed:", error.message);
    process.exit(1);
  }
  user = data.user;
  console.log(`✅ user created: ${user.id} (${user.email})`);
}

// 2. Ensure profile row exists + is_admin=true
const { data: profile, error: profErr } = await sb
  .from("profiles")
  .select("id, email, is_admin")
  .eq("id", user.id)
  .single();

if (profErr || !profile) {
  console.log("Profile not found, creating one");
  // The auth trigger should have created one already; if not, insert manually
  const { error: insErr } = await sb.from("profiles").insert({
    id: user.id,
    email: user.email,
    is_admin: true,
  });
  if (insErr) {
    console.error("❌ failed to create profile:", insErr.message);
    process.exit(1);
  }
  console.log("✅ profile created with is_admin=true");
} else if (!profile.is_admin) {
  console.log("Profile exists but is_admin=false, updating");
  const { error: updErr } = await sb
    .from("profiles")
    .update({ is_admin: true })
    .eq("id", user.id);
  if (updErr) {
    console.error("❌ failed to set is_admin:", updErr.message);
    process.exit(1);
  }
  console.log("✅ is_admin=true");
} else {
  console.log("✅ profile already has is_admin=true");
}

console.log("\n=== Ready! ===");
console.log(`Email:    ${EMAIL}`);
console.log(`Password: ${PASSWORD}`);
console.log(`User ID:  ${user.id}`);
console.log(`is_admin: true`);
console.log("\nNow sign in at: https://linkchinamed-admin-ac3l-sunoboxs-projects.vercel.app");
