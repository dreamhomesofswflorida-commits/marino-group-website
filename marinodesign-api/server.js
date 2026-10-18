// Marino Design staging server: receives a room photo, asks Replicate to stage it, returns the result.
const http = require("http");
const crypto = require("crypto");

const TOKEN = process.env.REPLICATE_API_TOKEN || "";
const MODEL = process.env.MODEL || "google/nano-banana";
const PER_IP = +(process.env.PER_IP_DAILY || 1);
const DAILY_CAP = +(process.env.DAILY_CAP || 100);
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://marinogroupswfl.com,https://www.marinogroupswfl.com").split(",");
const ROOMS = ["Living room", "Bedroom", "Dining room", "Kitchen", "Home office", "Lanai"];
const STYLES = ["Coastal", "Modern", "Luxury", "Scandinavian", "Farmhouse", "Mid-century"];
const API = process.env.REPLICATE_API_BASE || "https://api.replicate.com/v1";

// ---- Square photo packs ----
const SQ_TOKEN = process.env.SQUARE_ACCESS_TOKEN || "";
const SQ_LOCATION = process.env.SQUARE_LOCATION_ID || "";
const SQ = process.env.SQUARE_API_BASE || "https://connect.squareup.com/v2";
const SITE = process.env.SITE_URL || "https://marinogroupswfl.com/marinodesign/";
const PACKS = {
  starter: { name: "Marino Design Starter - 10 staged photos", photos: 10, cents: 1900 },
  pro: { name: "Marino Design Pro - 30 staged photos", photos: 30, cents: 4900 },
  agent: { name: "Marino Design Agent - 100 staged photos", photos: 100, cents: 12900 },
};
const USED_KEY = "md-used";
const usedCache = new Map();

async function sq(path, opts = {}) {
  const r = await fetch(SQ + path, {
    ...opts,
    headers: { Authorization: `Bearer ${SQ_TOKEN}`, "Square-Version": "2025-01-23", "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Square ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`); e.status = r.status; throw e; }
  return j;
}

let defReady = false;
async function ensureDefinition() {
  if (defReady) return;
  try {
    await sq("/orders/custom-attribute-definitions", { method: "POST", body: JSON.stringify({
      custom_attribute_definition: { key: USED_KEY, name: "Marino Design photos used",
        schema: { $ref: "https://developer-production-s.squarecdn.com/schemas/v1/common.json#squareup.common.Number" },
        visibility: "VISIBILITY_HIDDEN" } }) });
  } catch (e) { if (e.status !== 409 && !/already exists|DUPLICATE|CONFLICT/i.test(e.message)) throw e; }
  defReady = true;
}

async function createPack(id) {
  const p = PACKS[id]; if (!p) throw Object.assign(new Error("unknown pack"), { code: 400 });
  const made = await sq("/online-checkout/payment-links", { method: "POST", body: JSON.stringify({
    idempotency_key: crypto.randomUUID(),
    order: { location_id: SQ_LOCATION, line_items: [{ name: p.name, quantity: "1", base_price_money: { amount: p.cents, currency: "USD" } }],
      metadata: { md_pack: id, md_photos: String(p.photos) } },
    checkout_options: { redirect_url: SITE, ask_for_shipping_address: false },
  }) });
  const link = made.payment_link;
  await sq(`/online-checkout/payment-links/${link.id}`, { method: "PUT", body: JSON.stringify({
    payment_link: { version: link.version, checkout_options: { redirect_url: `${SITE}?code=${link.order_id}`, ask_for_shipping_address: false } } }) });
  return link.url;
}

async function balance(code) {
  if (!/^[A-Za-z0-9]{10,64}$/.test(code || "")) return null;
  let order;
  try { order = (await sq(`/orders/${code}`)).order; } catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }
  if (!order || order.location_id !== SQ_LOCATION || !order.metadata || !order.metadata.md_photos) return null;
  const paid = order.state === "COMPLETED" || ((order.tenders || []).length > 0 && (order.net_amount_due_money || {}).amount === 0);
  if (!paid) return { code, paid: false, total: 0, used: 0, left: 0 };
  const total = +order.metadata.md_photos;
  let used = usedCache.get(code);
  if (used === undefined) {
    try { const a = await sq(`/orders/${code}/custom-attributes/${USED_KEY}`); used = +(a.custom_attribute && a.custom_attribute.value) || 0; }
    catch (e) { if (e.status === 404) used = 0; else throw e; }
    usedCache.set(code, used);
  }
  return { code, paid: true, pack: order.metadata.md_pack, total, used, left: Math.max(0, total - used) };
}

async function spend(code) {
  const used = (usedCache.get(code) || 0) + 1;
  usedCache.set(code, used);
  await ensureDefinition();
  await sq(`/orders/${code}/custom-attributes/${USED_KEY}`, { method: "POST", body: JSON.stringify({
    custom_attribute: { value: String(used) }, idempotency_key: crypto.randomUUID() }) });
  return used;
}

let day = "", total = 0, perIp = new Map();
function allow(ip) {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; total = 0; perIp = new Map(); }
  if (total >= DAILY_CAP) return "busy";
  if ((perIp.get(ip) || 0) >= PER_IP) return "limit";
  return "";
}
function count(ip) { total++; perIp.set(ip, (perIp.get(ip) || 0) + 1); }

function prompt(room, style) {
  const r = room.toLowerCase();
  return `Virtually stage this empty ${r} for a real estate listing in a ${style.toLowerCase()} interior design style. ` +
    `Add realistic, well-proportioned furniture, a rug, lamps, art and tasteful decor that suit a ${r}. ` +
    `Keep everything that is already in the photo exactly the same: walls, ceiling, floor, windows, doors, cabinets, ` +
    `countertops, appliances, light fixtures, paint colors, the view outside and the camera angle. ` +
    `Do not remove or change any architecture. Photorealistic professional real estate photography, natural light.`;
}

async function rep(path, opts = {}) {
  const r = await fetch(path.startsWith("http") ? path : API + path, {
    ...opts, headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Replicate ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

async function stage(dataUrl, room, style) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw Object.assign(new Error("bad image"), { code: 400 });
  const fd = new FormData();
  fd.append("content", new Blob([Buffer.from(m[2], "base64")], { type: m[1] }), "room.jpg");
  const file = await rep("/files", { method: "POST", body: fd });
  const url = file.urls.get;
  const input = MODEL.includes("kontext")
    ? { prompt: prompt(room, style), input_image: url, output_format: "jpg" }
    : { prompt: prompt(room, style), image_input: [url], output_format: "jpg" };
  let p = await rep(`/models/${MODEL}/predictions`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "wait=60" }, body: JSON.stringify({ input }),
  });
  const until = Date.now() + 120000;
  while (!["succeeded", "failed", "canceled"].includes(p.status) && Date.now() < until) {
    await new Promise(r => setTimeout(r, 2000));
    p = await rep(p.urls.get);
  }
  if (p.status !== "succeeded") throw new Error(`prediction ${p.status}: ${p.error || ""}`);
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  const img = await fetch(out);
  const type = img.headers.get("content-type") || "image/jpeg";
  return `data:${type};base64,${Buffer.from(await img.arrayBuffer()).toString("base64")}`;
}

function send(res, code, obj, origin) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : ORIGINS[0];
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  const url = new URL(req.url, "http://x");
  const shop = !!(SQ_TOKEN && SQ_LOCATION);
  if (req.method === "GET" && url.pathname === "/credits") {
    if (!shop) return send(res, 503, { error: "shop closed" }, origin);
    try { const b = await balance(url.searchParams.get("code")); return b ? send(res, 200, b, origin) : send(res, 404, { error: "Code not found." }, origin); }
    catch (e) { console.error("credits failed:", e.message); return send(res, 502, { error: "Could not check the code." }, origin); }
  }
  if (req.method === "GET") return send(res, 200, { ok: true, ready: !!TOKEN, shop, model: MODEL }, origin);
  if (req.method !== "POST" || !["/stage", "/buy"].includes(url.pathname)) return send(res, 404, { error: "not found" }, origin);

  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 12e6) return send(res, 413, { error: "Photo too large." }, origin); chunks.push(c); }
  let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return send(res, 400, { error: "Bad request." }, origin); }
  if (url.pathname === "/buy") {
    if (!shop) return send(res, 503, { error: "shop closed" }, origin);
    try { return send(res, 200, { url: await createPack(body.pack) }, origin); }
    catch (e) { console.error("buy failed:", e.message); return send(res, e.code || 502, { error: "Could not start checkout." }, origin); }
  }
  if (!TOKEN) return send(res, 503, { error: "Staging is not set up yet." }, origin);
  const room = ROOMS.includes(body.room) ? body.room : "Living room";
  const style = STYLES.includes(body.style) ? body.style : "Coastal";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  let paid = null;
  if (body.code && shop) {
    try { paid = await balance(body.code); } catch (e) { console.error("balance failed:", e.message); return send(res, 502, { error: "Could not check the code." }, origin); }
    if (!paid || !paid.paid) return send(res, 402, { error: "badcode" }, origin);
    if (paid.left <= 0) return send(res, 402, { error: "empty", ...paid }, origin);
  } else {
    const why = allow(ip);
    if (why === "limit") return send(res, 429, { error: "limit" }, origin);
    if (why === "busy") return send(res, 429, { error: "busy" }, origin);
  }
  try {
    const image = await stage(body.image, room, style);
    let left;
    if (paid) { const used = await spend(paid.code).catch(e => { console.error("spend failed:", e.message); return paid.used + 1; }); left = paid.total - used; }
    else count(ip);
    console.log(`staged ${room}/${style} ${paid ? "code " + paid.code.slice(-6) + " left " + left : "free " + ip} (${total} free today)`);
    send(res, 200, { image, left }, origin);
  } catch (e) {
    console.error("stage failed:", e.message);
    send(res, e.code || 502, { error: "Staging failed." }, origin);
  }
}).listen(process.env.PORT || 10000, () => console.log("Marino Design API ready, model", MODEL));
