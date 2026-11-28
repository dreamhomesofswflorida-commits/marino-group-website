import { createClient } from "npm:@supabase/supabase-js@2";
const LINKS: Record<string, string> = {
  "plink_1Ugl8uBQ1yRgcf8pRKEejq3Y": "starter",
  "plink_1UglA0BQ1yRgcf8pxHUOYAwO": "pro",
};
const LESSONS = {
  en: ["Lesson-1-How-the-sales-work","Lesson-2-Finding-the-lists","Lesson-3-Researching-a-property","Lesson-4-Comps-and-your-maximum-bid","Lesson-5-Registering-and-bidding","Lesson-6-After-you-win"],
  es: ["Leccion-1-Como-funcionan-las-ventas","Leccion-2-Encontrar-las-listas","Leccion-3-Investigar-una-propiedad","Leccion-4-Comparables-y-tu-oferta-maxima","Leccion-5-Registro-y-ofertas","Leccion-6-Despues-de-ganar"],
};
const BONUS = {
  starter: { en: ["Checklists.pdf"], es: ["Listas-de-Verificacion.pdf"] },
  pro: { en: ["Checklists.pdf", "Max-Bid-Calculator.xlsx"], es: ["Listas-de-Verificacion.pdf", "Calculadora-Oferta-Maxima.xlsx"] },
};
const cors = { "Access-Control-Allow-Origin": "https://marinogroupswfl.com", "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const j = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { session_id, k } = await req.json();
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const key = Deno.env.get("STRIPE_COURSE_KEY");
    let tier: string | undefined, s: any = { amount_total: 0 }, verified = false;
    if (key && /^cs_(live|test)_[A-Za-z0-9]+$/.test(session_id || "")) {
      // strongest check: ask Stripe that this checkout was paid
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${session_id}`, { headers: { Authorization: `Bearer ${key}` } });
      s = await r.json();
      if (!r.ok) return j({ error: "We could not find that purchase." }, 404);
      tier = LINKS[s.payment_link];
      if (!tier || s.payment_status !== "paid") return j({ error: "This purchase is not complete." }, 403);
      verified = true;
    } else if (k) {
      // fallback: private tier access code that only the Stripe post-payment redirect contains
      const { data } = await sb.from("course_codes").select("tier").eq("code", k).eq("active", true).maybeSingle();
      tier = data?.tier;
    }
    if (!tier) return j({ error: "Missing or invalid purchase link." }, 403);
    const email = s.customer_details?.email || null, name = s.customer_details?.name || null;
    const { data: existing } = verified ? await sb.from("course_buyers").select("session_id").eq("session_id", session_id).maybeSingle() : { data: true };
    if (!existing) {
      await sb.from("course_buyers").insert({ session_id, tier, email, name, amount: s.amount_total });
      const link = `https://marinogroupswfl.com/course/thanks/?session_id=${session_id}`;
      if (email) await sb.from("outbox").insert({ kind: "course_welcome", to_email: email,
        subject: "Your Collier Foreclosure & Tax Deed Course access",
        body: `Hi${name ? " " + name.split(" ")[0] : ""},\n\nThank you for your purchase! Watch your lessons (English and Spanish) and download your bonuses here anytime:\n${link}\n\nSave this email, the link is your personal access.\n\nQuestions? Call or text (239) 776-2393.\n\nJorge Marino LLC\nJorge Marino, REALTOR® · Waterfront Realty Group, Inc.\n\nEducational only. Not legal, tax or investment advice.` });
      await sb.from("outbox").insert({ kind: "course_sale", to_email: "dhomeswfl@gmail.com",
        subject: `New course sale: ${tier} ($${(s.amount_total / 100).toFixed(2)})`, body: `${name || ""} ${email || ""} bought the ${tier} course.` });
    }
    const sign = async (p: string) => (await sb.storage.from("course").createSignedUrl(p, 6 * 3600)).data?.signedUrl;
    const out: Record<string, unknown> = { tier, email };
    for (const lang of ["en", "es"] as const) {
      out[lang] = {
        lessons: await Promise.all(LESSONS[lang].map(async (f) => ({ file: f, url: await sign(`${lang}/${f}.mp4`) }))),
        bonus: await Promise.all(BONUS[tier as "starter" | "pro"][lang].map(async (f) => ({ file: f, url: await sign(`${lang}/${f}`) }))),
      };
    }
    return j(out);
  } catch (e) { return j({ error: String(e) }, 500); }
});
