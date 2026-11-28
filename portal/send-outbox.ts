// Supabase Edge Function "send-outbox": sends the queued emails in the outbox table.
// Called every minute by pg_cron (see schema-v3 / setup). Paste into Supabase > Edge Functions > Deploy a new function.
//
// Secrets (Supabase > Edge Functions > Secrets) - set ONE of these two options:
//   Option A (Gmail):  GMAIL_USER = dhomeswfl@gmail.com   GMAIL_APP_PASSWORD = the 16-letter Google app password
//   Option B (Resend): RESEND_API_KEY = re_...            MAIL_FROM = Marino Group <alerts@marinogroupswfl.com>
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GMAIL_USER = Deno.env.get("GMAIL_USER");
const GMAIL_PASS = Deno.env.get("GMAIL_APP_PASSWORD");
const RESEND = Deno.env.get("RESEND_API_KEY");
const FROM = Deno.env.get("MAIL_FROM") || (GMAIL_USER ? `Marino Group <${GMAIL_USER}>` : "Marino Group <onboarding@resend.dev>");
const REPLY_TO = Deno.env.get("REPLY_TO") || GMAIL_USER || "dhomeswfl@gmail.com";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const html = (body: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1e1d1c;max-width:560px">` +
  esc(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2f5d62">$1</a>').replace(/\n/g, "<br>") +
  `</div>`;

async function send(to: string, subject: string, body: string, smtp?: SMTPClient) {
  if (smtp) {
    await smtp.send({ from: FROM, to, replyTo: REPLY_TO, subject, content: body, html: html(body) });
    return;
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, text: body, html: html(body) }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

Deno.serve(async () => {
  if (!RESEND && !(GMAIL_USER && GMAIL_PASS)) return new Response("No email service set up yet", { status: 200 });
  const { data: rows, error } = await db.from("outbox").select("*").eq("status", "queued").order("created_at").limit(25);
  if (error) return new Response(error.message, { status: 500 });
  if (!rows?.length) return new Response("nothing to send");
  const smtp = !RESEND ? new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: GMAIL_USER!, password: GMAIL_PASS! } } }) : undefined;
  let sent = 0;
  for (const m of rows) {
    try {
      await send(m.to_email, m.subject, m.body, smtp);
      await db.from("outbox").update({ status: "sent", sent_at: new Date().toISOString(), error: null }).eq("id", m.id);
      sent++;
    } catch (e) {
      await db.from("outbox").update({ status: "failed", error: String(e).slice(0, 500) }).eq("id", m.id);
    }
  }
  if (smtp) await smtp.close();
  return new Response(`sent ${sent} of ${rows.length}`);
});
