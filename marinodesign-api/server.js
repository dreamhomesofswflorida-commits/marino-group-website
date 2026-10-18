// Marino Design staging server: receives a room photo, asks Replicate to stage it, returns the result.
const http = require("http");

const TOKEN = process.env.REPLICATE_API_TOKEN || "";
const MODEL = process.env.MODEL || "google/nano-banana";
const PER_IP = +(process.env.PER_IP_DAILY || 3);
const DAILY_CAP = +(process.env.DAILY_CAP || 100);
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://marinogroupswfl.com,https://www.marinogroupswfl.com").split(",");
const ROOMS = ["Living room", "Bedroom", "Dining room", "Kitchen", "Home office", "Lanai"];
const STYLES = ["Coastal", "Modern", "Luxury", "Scandinavian", "Farmhouse", "Mid-century"];
const API = "https://api.replicate.com/v1";

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const origin = ORIGINS.includes(req.headers.origin) ? req.headers.origin : ORIGINS[0];
  if (req.method === "OPTIONS") return send(res, 204, {}, origin);
  if (req.method === "GET") return send(res, 200, { ok: true, ready: !!TOKEN, model: MODEL }, origin);
  if (req.method !== "POST" || req.url !== "/stage") return send(res, 404, { error: "not found" }, origin);
  if (!TOKEN) return send(res, 503, { error: "Staging is not set up yet." }, origin);

  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 12e6) return send(res, 413, { error: "Photo too large." }, origin); chunks.push(c); }
  let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return send(res, 400, { error: "Bad request." }, origin); }
  const room = ROOMS.includes(body.room) ? body.room : "Living room";
  const style = STYLES.includes(body.style) ? body.style : "Coastal";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const why = allow(ip);
  if (why === "limit") return send(res, 429, { error: "limit" }, origin);
  if (why === "busy") return send(res, 429, { error: "busy" }, origin);
  try {
    const image = await stage(body.image, room, style);
    count(ip);
    console.log(`staged ${room}/${style} for ${ip} (${total} today)`);
    send(res, 200, { image }, origin);
  } catch (e) {
    console.error("stage failed:", e.message);
    send(res, e.code || 502, { error: "Staging failed." }, origin);
  }
}).listen(process.env.PORT || 10000, () => console.log("Marino Design API ready, model", MODEL));
