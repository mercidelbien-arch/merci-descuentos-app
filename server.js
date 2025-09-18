// server.js — App Merci Descuentos (TN OAuth + Neon + Campañas)
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";
import { Pool } from "pg";
import cors from "cors";

import templatesRouter from "./api/routes/templates.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PROMO_ID = process.env.TN_PROMO_ID || "1c508de3-84a0-4414-9c75-c2aee4814fcd";

// -------------------- DB (Neon) --------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------- App --------------------
const app = express();
app.use(express.json());
app.use(cors());

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.SESSION_SECRET || "supersecret"],
    maxAge: 24 * 60 * 60 * 1000,
  })
);

// -------------------- Rutas API --------------------
app.use("/api/templates", templatesRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// -------------------- Admin estático --------------------
app.use("/admin", express.static(path.join(__dirname, "public", "admin")));

// -------------------- Inicio --------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on :${PORT}`);
});

export { pool };


const PROMO_ID = process.env.TN_PROMO_ID || "1c508de3-84a0-4414-9c75-c2aee4814fcd";

// -------------------- DB (Neon) --------------------
const { DATABASE_URL } = process.env;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use('/api/templates', templatesRouter);
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use(cookieSession({
  name: "sess",
  secret: process.env.SESSION_SECRET || "dev",
  httpOnly: true,
  sameSite: "lax",
}));

// Widget estático (solo /widget)
app.use("/widget", express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

// ⛔️ NO servir /admin como estático (rompe las subrutas)
// (Dejado explícitamente deshabilitado)

// -------------------- Salud --------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, data: { status: "ok", node: process.version, time: new Date().toISOString() } });
});

app.get("/api/db/ping", async (_req, res) => {
  if (!pool) return res.json({ ok: false, error: "DATABASE_URL no configurada" });
  try { const r = await pool.query("SELECT 1 AS ok"); res.json({ ok: true, data: r.rows[0] }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/debug/stores", async (_req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok:false, error:"DB no configurada" });
    const r = await pool.query("SELECT store_id, created_at FROM stores ORDER BY created_at DESC LIMIT 5");
    res.json({ ok:true, stores: r.rows });
  } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

// -------------------- Migraciones --------------------
const MIGRATE_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS stores (
    store_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',

    type TEXT NOT NULL CHECK (type IN ('percentage','absolute')),
    value INTEGER NOT NULL,

    discount_type TEXT,
    discount_value NUMERIC,

    valid_from DATE,
    valid_until DATE,
    apply_scope TEXT DEFAULT 'all',
    min_cart_amount NUMERIC DEFAULT 0,
    max_discount_amount NUMERIC,
    monthly_cap_amount NUMERIC,
    exclude_sale_items BOOLEAN DEFAULT false,

    min_cart INTEGER DEFAULT 0,
    monthly_cap INTEGER DEFAULT 0,
    exclude_on_sale BOOLEAN DEFAULT false,
    start_date DATE,
    end_date DATE,

    include_category_ids JSONB,
    exclude_category_ids JSONB,
    include_product_ids  JSONB,
    exclude_product_ids  JSONB,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),

    UNIQUE (store_id, code)
  );
`;
app.get("/api/db/migrate", async (_req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: "Sin pool de DB" });
  try { await pool.query(MIGRATE_SQL); res.json({ ok: true, message: "Migraciones aplicadas" }); }
  catch (e) { console.error("MIGRATE error:", e); res.status(500).json({ ok: false, error: e.message }); }
});

// -------------------- Home -> Admin --------------------
app.get("/", (_req, res) => { res.redirect("/admin/?store_id=3739596"); });

// -------------------- OAuth TN --------------------
app.get("/install", (req, res) => {
  const appId = process.env.TN_CLIENT_ID;
  if (!appId) return res.status(500).send("Falta TN_CLIENT_ID");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;
  const url = `https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");
    const expected = req.session?.state;
    if (expected && state !== expected) return res.status(400).send("Estado inválido");

    const redirect_uri = `${process.env.APP_BASE_URL}/oauth/callback`;
    const form = new URLSearchParams();
    form.append("client_id", process.env.TN_CLIENT_ID);
    form.append("client_secret", process.env.TN_CLIENT_SECRET);
    form.append("code", String(code));
    form.append("grant_type", "authorization_code");
    form.append("redirect_uri", redirect_uri);

    const tokenRes = await axios.post(
      "https://www.tiendanube.com/apps/authorize/token",
      form.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const data = tokenRes.data || {};
    const access_token = data.access_token;
    const sid = String(data.store_id || data.user_id || "").trim();
    if (!access_token) return res.status(400).send("No se recibió token");

    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (store_id) DO UPDATE
       SET access_token = EXCLUDED.access_token, updated_at = now()`,
      [sid, access_token]
    );

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth");
  }
});

// -------------------- TN API helpers --------------------
function tnBase(store_id) { return `https://api.tiendanube.com/v1/${store_id}`; }
function tnHeaders(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
    "Authentication": `bearer ${token}`,
  };
}

// -------------------- TN: categorías --------------------
app.get("/api/tn/categories", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: "No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const resp = await axios.get(`${tnBase(store_id)}/categories`, {
      headers: tnHeaders(token), params: { per_page: 250 },
    });

    const cats = (resp.data || []).map(c => ({
      id: c.id, name: c.name?.es || c.name?.pt || c.name?.en || String(c.id),
    }));
    return res.json(cats);
  } catch (e) {
    console.error("GET /api/tn/categories error:", e.response?.data || e.message);
    return res.status(e.response?.status || 500).json({ message: "Error obteniendo categorías", detail: e.response?.data || e.message });
  }
});

// -------------------- TN: callbacks/scripts/promotions (resumen) --------------------
app.all("/api/tn/register-callback", async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: "No hay token para esa tienda" });
    const token = r.rows[0].access_token;
    const callbackUrl = `${process.env.APP_BASE_URL}/discounts/callback`;
    const resp = await axios.put(`${tnBase(store_id)}/discounts/callbacks`, { url: callbackUrl }, { headers: tnHeaders(token), timeout: 8000 });
    return res.json({ ok: true, data: resp.data || null, url: callbackUrl });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.get("/api/tn/promotions/register-base", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;
    const body = { name: "Merci Engine – Base", allocation_type: "cross_items" };
    const resp = await axios.post(`${tnBase(store_id)}/promotions`, body, { headers: tnHeaders(token) });
    return res.json({ ok:true, data: resp.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.get("/api/tn/scripts/list", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;
    const listRes = await axios.get(`${tnBase(store_id)}/scripts`, { headers: tnHeaders(token) });
    return res.json({ ok:true, raw:listRes.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.all("/api/tn/scripts/install/by-id", async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || "").trim();
    const script_id = String((req.body?.script_id) || req.query.script_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    if (!script_id) return res.status(400).json({ ok:false, error:"Falta script_id" });

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;
    try {
      const upd = await axios.put(`${tnBase(store_id)}/scripts/${script_id}`, { script_id, enabled: true }, { headers: tnHeaders(token) });
      return res.json({ ok:true, action:"updated_by_id", data: upd.data });
    } catch (e1) {
      const created = await axios.post(`${tnBase(store_id)}/scripts`, { script_id, enabled: true }, { headers: tnHeaders(token) });
      return res.json({ ok:true, action:"created_by_id", data: created.data });
    }
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.all("/api/tn/scripts/install/direct", async (req, res) => {
  try {
    const store_id = String(req.body?.store_id || req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    const src = String(req.body?.src || req.query.src || `${process.env.APP_BASE_URL}/widget/merci-checkout-coupon-widget.js`).trim();
    const name = String(req.body?.name || req.query.name || "Merci Checkout Widget (direct)").trim();
    const event = String(req.body?.event || req.query.event || "onload").trim();
    const location = String(req.body?.location || req.query.location || "checkout").trim();

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const body = { name, src, event, location, enabled: true };
    const created = await axios.post(`${tnBase(store_id)}/scripts`, body, { headers: tnHeaders(token) });
    return res.json({ ok:true, action:"created_direct", data: created.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ================== Métricas Home ==================
function monthRange(offset = 0) {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}
function pctChange(curr, prev) {
  if (!prev || prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

// ===== Admin (layout con vistas: home, campaigns, create, coupons) =====
app.get("/admin", (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  const view = String(req.query.view || "home"); // 'home' | 'campaigns' | 'create' | 'coupons'
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  const layout = (title, inner) => `
  <!doctype html>
  <html lang="es"><head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${title} · Merci</title>
    <style>
      :root{--bg:#f7f8fa;--card:#fff;--muted:#64748b;--line:#e5e7eb;--brand:#4338ca}
      body{margin:0;background:var(--bg);color:#0f172a;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial}
      .layout{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
      .aside{background:#fff;border-right:1px solid var(--line);padding:20px}
      .brand{font-weight:700;margin:0 0 8px}
      .nav a{display:block;padding:10px 12px;border-radius:10px;color:#0f172a;text-decoration:none;margin:4px 0}
      .nav a.active{background:#eef2ff;color:var(--brand)}
      .main{padding:24px}
      .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
      .card{background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.04);padding:18px}
      .tile{cursor:pointer;transition:.15s;text-decoration:none;color:inherit}
      .tile:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.08)}
      .icon{width:40px;height:40px;border-radius:10px;background:#eef2ff;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
      .title{font-weight:700;margin:0 0 4px}
      .muted{color:var(--muted);font-size:14px;margin:0}
      .btn{display:inline-block;padding:10px 14px;border-radius:10px;color:#fff;background:var(--brand);text-decoration:none}
      .kpi{font-size:28px;font-weight:800;margin:6px 0}
      label{display:block;font-size:12px;color:#555;margin-top:10px}
      input,select{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;margin-top:6px}
      .row{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
      .row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    </style>
  </head><body>
    <div class="layout">
      <aside class="aside">
        <h3 class="brand">Merci Descuentos</h3>
        <nav class="nav">
          <a href="/admin/?store_id=${store_id}&view=home" class="${view==='home'?'active':''}">Página principal</a>
          <a href="/admin/?store_id=${store_id}&view=campaigns" class="${view==='campaigns'?'active':''}">Campañas</a>
          <a href="#" onclick="alert('Próximo');return false;">Categorías</a>
          <a href="#" onclick="alert('Próximo');return false;">Redenciones</a>
          <a href="#" onclick="alert('Próximo');return false;">Clientes</a>
          <a href="/api/health" target="_blank">Salud & Logs</a>
        </nav>
      </aside>
      <main class="main">${inner}</main>
    </div>
  </body></html>`;

  // -------- HOME --------
  const home = () => {
    const d = new Date(), meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const mesAnio = meses[d.getMonth()].charAt(0).toUpperCase()+meses[d.getMonth()].slice(1)+" "+d.getFullYear();
    return `
      <div class="head">
        <div>
          <h1 style="margin:0">Página principal</h1>
          <div class="muted">Resumen analítico — ${mesAnio}</div>
        </div>
        <div style="display:flex;gap:10px">
          <a class="btn" href="/api/metrics/export.csv?store_id=${store_id}" style="background:#e5e7eb;color:#111">Exportar CSV</a>
          <a class="btn" href="/admin/?store_id=${store_id}&view=campaigns">Crear campaña</a>
        </div>
      </div>
      <div class="grid">
        <div class="card"><div class="muted">Monto total descontado</div><div class="kpi">$ 428.450</div><div class="muted">Suma de descuentos aplicados en el mes</div><div class="muted">Vs. mes anterior · <span style="color:#16a34a">+18%</span></div></div>
        <div class="card"><div class="muted">Pedidos con descuento</div><div class="kpi">286</div><div class="muted">Órdenes con al menos 1 cupón</div><div class="muted">Vs. mes anterior · <span style="color:#16a34a">+11%</span></div></div>
        <div class="card"><div class="muted">Clientes beneficiados</div><div class="kpi">241</div><div class="muted">Únicos en el mes</div></div>
        <div class="card"><div class="muted">Top campaña activa</div><div class="kpi">10% en Secos</div><div class="muted">Participación 42%</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="margin:0 0 10px">Usos por día</h3>
        <canvas id="chart" width="980" height="300"></canvas>
      </div>
      <script>
        (function(){var c=document.getElementById('chart');if(!c)return;var x=c.getContext('2d'),W=c.width,H=c.height,L=30;
          var d=Array.from({length:L},(_,i)=>8+Math.round(10*Math.abs(Math.sin(i/3))+(Math.random()*4-2)));
          x.strokeStyle='#e5e7eb';x.beginPath();x.moveTo(40,10);x.lineTo(40,H-30);x.lineTo(W-10,H-30);x.stroke();
          var max=Math.max.apply(null,d),min=Math.min.apply(null,d),dx=(W-70)/(L-1),sc=(H-60)/(max-min||1);
          x.strokeStyle='#2563eb';x.lineWidth=2;x.beginPath();
          d.forEach(function(v,i){var X=40+i*dx,Y=(H-30)-(v-min)*sc;i?x.lineTo(X,Y):x.moveTo(X,Y)});x.stroke();
        })();
      </script>`;
  };

  // -------- CAMPAIGNS (grilla de “botones”) --------
  const campaigns = () => `
    <div class="head"><h1 style="margin:0">Campañas</h1></div>
    <div class="grid">
      <a class="card tile" href="/admin/?store_id=${store_id}&view=coupons">
        <div class="icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#4338ca" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="7" cy="7" r="1.5"></circle><circle cx="17" cy="17" r="1.5"></circle><path d="M7 17L17 7"></path>
          </svg>
        </div>
        <h3 class="title">Cupones %</h3>
        <p class="muted">Descuento en subtotal del carrito usando código.</p>
      </a>
      <div class="card tile" onclick="alert('Próximo: 3x2')">
        <div class="icon"></div><h3 class="title">3×2</h3><p class="muted">Llevá X, pagá Y (próximo).</p>
      </div>
      <div class="card tile" onclick="alert('Próximo: Progresivo')">
        <div class="icon"></div><h3 class="title">Progresivo</h3><p class="muted">Descuento por cantidad (próximo).</p>
      </div>
    </div>
  `;

  // -------- CREATE (form) --------
  const create = () => `
    <h1 style="margin:0 0 8px">Cupones Merci — <span class="muted">Tienda ${store_id||''}</span></h1>
    <p class="muted">Crear y segmentar campañas por categorías.</p>
    <div class="card">
      <h3>Nueva campaña</h3>
      <form id="f">
        <div class="row">
          <div><label>Store ID</label><input name="store_id" value="${store_id||''}" required></div>
          <div><label>Código del cupón</label><input name="code" placeholder="EJ: GIMNASIO10" required></div>
        </div>
        <label>Nombre interno</label>
        <input name="name" placeholder="EJ: Convenio Gimnasios 10%" required>
        <div class="row">
          <div><label>Tipo de descuento</label>
            <select name="discount_type"><option value="percent" selected>%</option><option value="fixed">Monto fijo</option></select>
          </div>
          <div><label>Valor</label><input name="discount_value" type="number" step="1" value="10" required></div>
        </div>
        <div class="row">
          <div><label>Vigencia desde</label><input name="valid_from" type="date" required></div>
          <div><label>Vigencia hasta</label><input name="valid_until" type="date" required></div>
        </div>
        <div class="row3">
          <div>
            <label>Ámbito</label>
            <select name="apply_scope" id="apply_scope">
              <option value="all" selected>Toda la tienda</option>
              <option value="categories">Categorías incluidas</option>
              <option value="products">Productos (próximo)</option>
            </select>
          </div>
          <div><label>Mínimo carrito</label><input name="min_cart_amount" type="number" step="1" value="0"></div>
          <div><label>Excluir productos en oferta</label>
            <select name="exclude_sale_items"><option value="false" selected>No</option><option value="true">Sí</option></select>
          </div>
        </div>
        <div id="cats_block" style="display:none">
          <label>Categorías para incluir (Ctrl/Cmd + clic para múltiples)</label>
          <select id="include_categories" class="multi" multiple></select>
          <label style="margin-top:12px">Categorías a excluir</label>
          <select id="exclude_categories" class="multi" multiple></select>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px">
          <button type="submit" class="btn">Crear campaña</button>
          <a class="btn" href="/admin/?store_id=${store_id}&view=campaigns" style="background:#e5e7eb;color:#111">Volver</a>
        </div>
        <div id="msg" class="muted" style="margin-top:8px"></div>
      </form>
    </div>

    <div class="card"><h3>Campañas existentes</h3><div id="list" class="muted">Cargando…</div></div>

    <script>
      const $ = (s, el)=> (el||document).querySelector(s);
      const toBool = v => String(v) === 'true';
      const selectedIds = sel => Array.from(sel.selectedOptions).map(o=> Number(o.value));
      function formToPayload(f){
        var fd = new FormData(f);
        var p = {
          store_id: fd.get('store_id'),
          code: fd.get('code'),
          name: fd.get('name'),
          discount_type: fd.get('discount_type'),
          discount_value: Number(fd.get('discount_value')),
          valid_from: fd.get('valid_from'),
          valid_until: fd.get('valid_until'),
          apply_scope: fd.get('apply_scope'),
          min_cart_amount: Number(fd.get('min_cart_amount') || 0),
          exclude_sale_items: toBool(fd.get('exclude_sale_items'))
        };
        if (p.apply_scope === 'categories'){
          p.include_category_ids = selectedIds(document.querySelector('#include_categories'));
          p.exclude_category_ids = selectedIds(document.querySelector('#exclude_categories'));
        }
        return p;
      }
      function api(path, opts){ return fetch(path, opts).then(r=>r.json().then(d=>{ if(!r.ok) throw d; return d; })); }
      function listCampaigns(sid){ return api('/api/campaigns?store_id='+encodeURIComponent(sid)); }
      function fetchCategories(sid){ return api('/api/tn/categories?store_id='+encodeURIComponent(sid)); }
      function renderList(rows){
        if(!rows || rows.length===0){ document.querySelector('#list').innerHTML='<p class="muted">No hay campañas.</p>'; return; }
        var html='<table style="width:100%;border-collapse:collapse"><thead><tr>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Nombre</th>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Código</th>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Tipo</th>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Valor</th>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Ámbito</th>'+
          '<th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Vigencia</th>'+
          '</tr></thead><tbody>';
        html += rows.map(function(r){
          var val = r.discount_type==='percent' ? (r.discount_value+'%') : ('$'+r.discount_value);
          return '<tr>'+
            '<td style="padding:8px;border-bottom:1px solid #eee">'+r.name+'</td>'+
            '<td style="padding:8px;border-bottom:1px solid #eee"><code>'+r.code+'</code></td>'+
            '<td style="padding:8px;border-bottom:1px solid #eee">'+r.discount_type+'</td>'+
            '<td style="padding:8px;border-bottom:1px solid #eee">'+val+'</td>'+
            '<td style="padding:8px;border-bottom:1px solid #eee">'+r.apply_scope+'</td>'+
            '<td style="padding:8px;border-bottom:1px solid #eee">'+r.valid_from+' → '+r.valid_until+'</td>'+
          '</tr>';
        }).join('') + '</tbody></table>';
        document.querySelector('#list').innerHTML = html;
      }
      function refresh(){
        var sid = document.querySelector('input[name=store_id]').value.trim();
        if(!sid){ document.querySelector('#list').innerHTML='<p class="muted">Ingresá Store ID arriba.</p>'; return; }
        document.querySelector('#list').textContent='Cargando…';
        listCampaigns(sid).then(renderList).catch(()=> document.querySelector('#list').innerHTML='<p class="muted">Error cargando campañas.</p>');
      }
      function maybeLoadCats(){
        var scope = document.querySelector('#apply_scope').value;
        var block = document.querySelector('#cats_block');
        if(scope!=='categories'){ block.style.display='none'; return; }
        block.style.display='block';
        var sid = document.querySelector('input[name=store_id]').value.trim();
        if(!sid){ document.querySelector('#msg').textContent='Ingresá Store ID para cargar categorías'; return; }
        document.querySelector('#msg').textContent='Cargando categorías…';
        fetchCategories(sid).then(function(cats){
          var inc = document.querySelector('#include_categories');
          var exc = document.querySelector('#exclude_categories');
          inc.innerHTML = cats.map(c=> '<option value="'+c.id+'">'+c.name+'</option>').join('');
          exc.innerHTML = cats.map(c=> '<option value="'+c.id+'">'+c.name+'</option>').join('');
          document.querySelector('#msg').textContent='';
        }).catch(()=> document.querySelector('#msg').textContent='No se pudieron cargar categorías');
      }
      document.querySelector('#apply_scope').addEventListener('change', maybeLoadCats);
      document.querySelector('#f').addEventListener('submit', function(ev){
        ev.preventDefault(); document.querySelector('#msg').textContent='Creando…';
        var payload = formToPayload(ev.target);
        api('/api/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
          .then(function(){ document.querySelector('#msg').textContent='Campaña creada ✅'; refresh(); })
          .catch(function(e){ document.querySelector('#msg').textContent='Error: '+(e.detail||e.message||'No se pudo crear'); });
      });
      window.addEventListener('load', refresh);
    </script>
  `;

  // -------- COUPONS (lista vigentes + botón crear) --------
  const coupons = (sid) => `
    <div class="head">
      <h1 style="margin:0">Cupones</h1>
      <div style="display:flex;gap:8px">
        <a class="btn" href="/admin/?store_id=${sid}&view=create">➕ Crear cupón</a>
      </div>
    </div>

    <div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
        <input id="q" placeholder="Buscar por código"
               style="flex:1;padding:10px 12px;border:1px solid #e5e7eb;border-radius:10px">
        <button id="sort" class="btn" style="background:#e5e7eb;color:#111">A–Z</button>
      </div>

      <div id="count" class="muted" style="margin:6px 0">Cargando…</div>

      <div style="overflow:auto">
        <table style="width:100%;border-collapse:collapse" id="tbl">
          <thead>
            <tr>
              <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Código</th>
              <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Descuento</th>
              <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Usos</th>
              <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Vigencia</th>
              <th style="text-align:left;border-bottom:1px solid #eee;padding:8px">Estado</th>
            </tr>
          </thead>
          <tbody id="rows">
            <tr><td colspan="5" style="padding:12px" class="muted">Cargando…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <script>
      const SID = ${JSON.stringify(sid || "")};
      const $ = (s, el)=> (el||document).querySelector(s);
      let data = [], asc = true;

      function fmtDesc(r){
        if ((r.discount_type||'percent') === 'percent') return (r.discount_value||0) + ' %';
        return '$ ' + Number(r.discount_value||0);
      }
      function fmtDate(d){ return d ? String(d) : '—'; }

      function render(list){
        const q = ($('#q').value||'').trim().toUpperCase();
        let rows = list.filter(r => (r.code||'').toUpperCase().includes(q));
        document.querySelector('#count').textContent = rows.length + ' cupón(es) vigentes';
        if (asc) rows.sort((a,b)=> a.code.localeCompare(b.code)); else rows.sort((a,b)=> b.code.localeCompare(a.code));

        if (rows.length === 0){
          document.querySelector('#rows').innerHTML = '<tr><td colspan="5" style="padding:12px" class="muted">Sin resultados</td></tr>';
          return;
        }
        document.querySelector('#rows').innerHTML = rows.map(r => (
          '<tr>' +
            '<td style="padding:8px;border-bottom:1px solid #eee"><code>'+r.code+'</code></td>' +
            '<td style="padding:8px;border-bottom:1px solid #eee">'+fmtDesc(r)+'</td>' +
            '<td style="padding:8px;border-bottom:1px solid #eee">'+(r.uses||0)+'</td>' +
            '<td style="padding:8px;border-bottom:1px solid #eee">'+fmtDate(r.valid_from)+' → '+fmtDate(r.valid_until)+'</td>' +
            '<td style="padding:8px;border-bottom:1px solid #eee"><span style="background:#dcfce7;color:#166534;padding:4px 8px;border-radius:999px;font-size:12px">Activado</span></td>' +
          '</tr>'
        )).join('');
      }

      function load(){
        fetch('/api/campaigns/active?store_id='+encodeURIComponent(SID))
          .then(r=>r.json())
          .then(r=>{ data = Array.isArray(r) ? r : []; render(data); })
          .catch(()=>{ document.querySelector('#rows').innerHTML = '<tr><td colspan="5" style="padding:12px" class="muted">Error cargando</td></tr>'; });
      }

      document.querySelector('#q').addEventListener('input', ()=> render(data));
      document.querySelector('#sort').addEventListener('click', ()=> { asc = !asc; render(data); });

      window.addEventListener('load', load);
    </script>
  `;

  const body =
    view === "campaigns" ? campaigns()
  : view === "create"    ? create()
  : view === "coupons"   ? coupons(store_id)
  :                        home();

  res.end(layout("Panel de administración", body));
});

// -------------------- API campañas --------------------
app.get("/api/campaigns", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, store_id, code, name, status,
              discount_type, discount_value,
              valid_from, valid_until,
              apply_scope, min_cart_amount,
              max_discount_amount, monthly_cap_amount,
              exclude_sale_items,
              created_at, updated_at
         FROM campaigns
        WHERE store_id = $1
        ORDER BY created_at DESC`,
      [store_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/campaigns error:", err);
    res.status(500).json({ message: "Error al obtener campañas" });
  }
});

app.post("/api/campaigns", async (req, res) => {
  try {
    const b = req.body || {};
    const store_id = String(b.store_id || "").trim();
    const code = String(b.code || "").trim();
    const name = String(b.name || "").trim();
    if (!store_id || !code || !name) return res.status(400).json({ message: "Faltan store_id, code o name" });

    const discount_type = (b.discount_type || "percent").toLowerCase(); // 'percent' | 'fixed'
    const discount_value_num = Number(b.discount_value ?? 0);
    const type = discount_type === "percent" ? "percentage" : "absolute";
    const value = Number.isFinite(discount_value_num) ? Math.round(discount_value_num) : 0;

    const valid_from = b.valid_from || new Date().toISOString().slice(0,10);
    const valid_until = b.valid_until || new Date().toISOString().slice(0,10);
    const apply_scope = (b.apply_scope || "all").toString();

    const min_cart_amount   = b.min_cart_amount   !== undefined ? Number(b.min_cart_amount)   : 0;
    const max_discount_amount = b.max_discount_amount !== undefined ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount = b.monthly_cap_amount !== undefined ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true;

    const toJsonb = (arr) => (Array.isArray(arr) && arr.length ? JSON.stringify(arr.map(Number)) : null);
    const include_category_ids = toJsonb(b.include_category_ids);
    const exclude_category_ids = toJsonb(b.exclude_category_ids);
    const include_product_ids  = toJsonb(b.include_product_ids);
    const exclude_product_ids  = toJsonb(b.exclude_product_ids);

    const min_cart     = b.min_cart     != null ? Number(b.min_cart)     : 0;
    const monthly_cap  = b.monthly_cap  != null ? Number(b.monthly_cap)  : 0;
    const exclude_on_sale = b.exclude_on_sale != null ? !!b.exclude_on_sale : false;
    const status = "active";

    const sql = `
      INSERT INTO campaigns (
        id, store_id, name, code,
        type, value, min_cart, monthly_cap,
        start_date, end_date,
        exclude_on_sale, status,
        created_at, updated_at,
        discount_type, discount_value,
        valid_from, valid_until, apply_scope,
        min_cart_amount, max_discount_amount, monthly_cap_amount,
        exclude_sale_items,
        include_category_ids, exclude_category_ids,
        include_product_ids, exclude_product_ids
      ) VALUES (
        gen_random_uuid(),
        $1, $2, $3,
        $4, $5, $6, $7,
        NULL, NULL,
        $8, $9,
        now(), now(),
        $10, $11,
        $12, $13, $14,
        $15, $16, $17,
        $18,
        $19::jsonb, $20::jsonb,
        $21::jsonb, $22::jsonb
      )
      RETURNING id, store_id, code, name, created_at
    `;
    const params = [
      store_id, name, code,
      type, value, min_cart, monthly_cap,
      exclude_on_sale, status,            // $8, $9
      discount_type, discount_value_num,  // $10, $11
      valid_from, valid_until, apply_scope, // $12, $13, $14
      min_cart_amount, max_discount_amount, monthly_cap_amount, // $15, $16, $17
      exclude_sale_items,                  // $18
      include_category_ids, exclude_category_ids, // $19, $20
      include_product_ids, exclude_product_ids    // $21, $22
    ];
    const r = await pool.query(sql, params);
    return res.json({ ok: true, campaign: r.rows[0] });
  } catch (e) {
    console.error("POST /api/campaigns error:", e);
    return res.status(500).json({ message: "Error al crear campaña", detail: e.detail || e.message });
  }
});

// -------------------- API: campañas vigentes (única) --------------------
app.get("/api/campaigns/active", async (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  if (!store_id) return res.json([]);
  const today = new Date().toISOString().slice(0,10);

  const sqlWithUses = `
    WITH c AS (
      SELECT id, store_id, code, name, status,
             discount_type, discount_value,
             valid_from, valid_until,
             apply_scope, min_cart_amount,
             max_discount_amount, monthly_cap_amount,
             exclude_sale_items, created_at, updated_at
        FROM campaigns
       WHERE store_id = $1
         AND status = 'active'
         AND ($2::date >= COALESCE(valid_from, $2::date))
         AND ($2::date <= COALESCE(valid_until, $2::date))
    ),
    u AS (
      SELECT UPPER(code) AS code, COUNT(*)::int AS uses
        FROM coupon_ledger
       WHERE store_id = $1
       GROUP BY 1
    )
    SELECT c.*, COALESCE(u.uses,0) AS uses
      FROM c LEFT JOIN u ON UPPER(c.code)=u.code
     ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC;
  `;

  const sqlNoUses = `
    SELECT id, store_id, code, name, status,
           discount_type, discount_value,
           valid_from, valid_until,
           apply_scope, min_cart_amount,
           max_discount_amount, monthly_cap_amount,
           exclude_sale_items, created_at, updated_at,
           0::int AS uses
      FROM campaigns
     WHERE store_id = $1
       AND status = 'active'
       AND ($2::date >= COALESCE(valid_from, $2::date))
       AND ($2::date <= COALESCE(valid_until, $2::date))
     ORDER BY updated_at DESC NULLS LAST, created_at DESC;
  `;

  try {
    const { rows } = await pool.query(sqlWithUses, [store_id, today]);
    return res.json(rows);
  } catch (e) {
    if (/relation .*coupon_ledger.* does not exist/i.test(String(e.message||e))) {
      const { rows } = await pool.query(sqlNoUses, [store_id, today]);
      return res.json(rows);
    }
    console.error("GET /api/campaigns/active error:", e);
    return res.status(500).json({ message: "Error listando cupones activos" });
  }
});

// ================== /Métricas Home ==================
app.get("/api/metrics/summary", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!pool) return res.status(500).json({ ok:false, error:"DB no configurada" });
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    const { from: mFrom, to: mTo } = monthRange(0);
    const { from: pFrom, to: pTo } = monthRange(-1);

    const [{ rows: r1 }, { rows: r2 }, { rows: r3 }] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(applied_amount),0)::numeric AS total
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`,
        [store_id, mFrom, mTo]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT COALESCE(order_id, checkout_id))::int AS orders
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`,
        [store_id, mFrom, mTo]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT customer_id)::int AS customers
           FROM coupon_ledger
          WHERE store_id=$1 AND customer_id IS NOT NULL
            AND created_at >= $2 AND created_at < $3`,
        [store_id, mFrom, mTo]
      )
    ]);

    const month_total     = Number(r1[0]?.total || 0);
    const month_orders    = Number(r2[0]?.orders || 0);
    const month_customers = Number(r3[0]?.customers || 0);

    const [{ rows: pr1 }, { rows: pr2 }, { rows: pr3 }] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(applied_amount),0)::numeric AS total
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`,
        [store_id, pFrom, pTo]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT COALESCE(order_id, checkout_id))::int AS orders
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`,
        [store_id, pFrom, pTo]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT customer_id)::int AS customers
           FROM coupon_ledger
          WHERE store_id=$1 AND customer_id IS NOT NULL
            AND created_at >= $2 AND created_at < $3`,
        [store_id, pFrom, pTo]
      )
    ]);

    const prev_total     = Number(pr1[0]?.total || 0);
    const prev_orders    = Number(pr2[0]?.orders || 0);
    const prev_customers = Number(pr3[0]?.customers || 0);

    const { rows: topRows } = await pool.query(
      `
      WITH m AS (
        SELECT UPPER(code) AS code, SUM(applied_amount)::numeric AS amt
          FROM coupon_ledger
         WHERE store_id=$1 AND created_at >= $2 AND created_at < $3
         GROUP BY 1
      ),
      t AS (SELECT SUM(amt)::numeric AS total FROM m)
      SELECT c.name, c.code, m.amt,
             CASE WHEN t.total>0 THEN ROUND(100*m.amt/t.total,1) ELSE 0 END AS share
        FROM m JOIN t ON true
        LEFT JOIN campaigns c
               ON c.store_id=$1 AND UPPER(c.code)=m.code AND c.status='active'
       ORDER BY m.amt DESC NULLS LAST
       LIMIT 1
      `,
      [store_id, mFrom, mTo]
    );

    res.json({
      ok: true,
      month: {
        total_discount: month_total,
        orders_with_coupon: month_orders,
        customers: month_customers,
        change_vs_prev: {
          total_discount_pct:  pctChange(month_total, prev_total),
          orders_with_coupon_pct: pctChange(month_orders, prev_orders),
          customers_pct: pctChange(month_customers, prev_customers),
        },
        top_campaign: topRows[0] || null
      }
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/relation .*coupon_ledger.* does not exist/i.test(msg)) {
      return res.json({
        ok: true,
        month: {
          total_discount: 0,
          orders_with_coupon: 0,
          customers: 0,
          change_vs_prev: { total_discount_pct: 0, orders_with_coupon_pct: 0, customers_pct: 0 },
          top_campaign: null
        }
      });
    }
    console.error("GET /api/metrics/summary error:", e);
    res.status(500).json({ ok:false, error: msg });
  }
});

app.get("/api/metrics/series/daily", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!pool) return res.status(500).json({ ok:false, error:"DB no configurada" });
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    const { from: mFrom, to: mTo } = monthRange(0);

    const [{ rows: uses }, { rows: amounts }] = await Promise.all([
      pool.query(
        `SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS uses
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3
          GROUP BY 1 ORDER BY 1`,
        [store_id, mFrom, mTo]
      ),
      pool.query(
        `SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(applied_amount),0)::numeric AS amount
           FROM coupon_ledger
          WHERE store_id=$1 AND created_at >= $2 AND created_at < $3
          GROUP BY 1 ORDER BY 1`,
        [store_id, mFrom, mTo]
      )
    ]);

    res.json({ ok:true, uses_per_day: uses, amount_per_day: amounts });
  } catch (e) {
    const msg = String(e.message || e);
    if (/relation .*coupon_ledger.* does not exist/i.test(msg)) {
      return res.json({ ok:true, uses_per_day: [], amount_per_day: [] });
    }
    console.error("GET /api/metrics/series/daily error:", e);
    res.status(500).json({ ok:false, error: msg });
  }
});

// -------------------- Discounts Callback (motor) --------------------
app.post("/discounts/callback", async (req, res) => {
  try {
    const body = req.body || {};
    const store_id = String(body.store_id || "").trim();
    const currency = body.currency || "ARS";
    if (!store_id || !pool) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    const tryStr = (v) => (typeof v === "string" ? v.trim() : "");
    const scanArray = (arr) => {
      if (!Array.isArray(arr)) return "";
      for (const it of arr) {
        const k = tryStr(it?.name || it?.key).toLowerCase();
        const v = tryStr(it?.value);
        if (!k || !v) continue;
        if (/(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(k)) return v;
      }
      return "";
    };
    const scanObject = (obj) => {
      if (!obj || typeof obj !== "object") return "";
      for (const [k, v] of Object.entries(obj)) {
        const kk = tryStr(k).toLowerCase(); const vv = tryStr(v);
        if (!kk || !vv) continue;
        if (/(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(kk)) return vv;
      }
      return "";
    };
    const getCodeFromPayload = (b) =>
      tryStr(b.code) || scanArray(b.custom_fields) || scanArray(b.additional_fields) ||
      scanArray(b.note_attributes) || scanArray(b?.checkout?.custom_fields) ||
      scanArray(b?.checkout?.attributes) || scanObject(b.attributes) ||
      scanObject(b.checkout?.attributes) || "";

    let code = getCodeFromPayload(body).toUpperCase();

    const checkout_id = String(body.checkout_id || body.checkout_token || (body.checkout && body.checkout.id) || body.token || "").trim();
    if (!code && checkout_id) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS checkout_codes (
          checkout_id TEXT PRIMARY KEY,
          code        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT now()
        )`);
      const r = await pool.query(`SELECT code FROM checkout_codes WHERE checkout_id = $1 LIMIT 1`, [checkout_id]);
      if (r.rowCount > 0) code = String(r.rows[0].code || "").trim().toUpperCase();
    }
    if (!code) return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });

    const q = await pool.query(
      `SELECT * FROM campaigns WHERE store_id = $1 AND UPPER(code) = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [store_id, code]
    );
    if (q.rowCount === 0) return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    const c = q.rows[0];

    const today = new Date().toISOString().slice(0,10);
    if ((c.valid_from && today < c.valid_from) || (c.valid_until && today > c.valid_until)) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    const products = Array.isArray(body.products) ? body.products : [];
    const parseJsonb = (v) => { if (Array.isArray(v)) return v; if (!v) return []; try { return JSON.parse(v); } catch { return []; } };
    const inc = parseJsonb(c.include_category_ids).map(Number);
    const exc = parseJsonb(c.exclude_category_ids).map(Number);
    const getCatIds = (p) => {
      if (Array.isArray(p.category_ids)) return p.category_ids.map(Number);
      if (Array.isArray(p.categories)) {
        const ids = [];
        for (const cat of p.categories) {
          if (cat && cat.id != null) ids.push(Number(cat.id));
          if (Array.isArray(cat.subcategories)) ids.push(...cat.subcategories.map(Number));
        }
        return ids;
      }
      return [];
    };

    let eligibleSubtotal = 0;
    for (const p of products) {
      const price = Number(p.price || 0);
      const qty   = Number(p.quantity || 0);
      let ok = true;
      if (String(c.apply_scope || "all") === "categories") {
        const cats = getCatIds(p);
        const matchesInc = inc.length === 0 ? true : cats.some(id => inc.includes(id));
        const matchesExc = exc.length > 0   ? cats.some(id => exc.includes(id)) : false;
        ok = matchesInc && !matchesExc;
      }
      if (ok) eligibleSubtotal += price * qty;
    }
    if (eligibleSubtotal <= 0) return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });

    if (c.min_cart_amount && eligibleSubtotal < Number(c.min_cart_amount)) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    const dtype = String(c.discount_type || 'percent').toLowerCase();
    const dval  = Number(c.discount_value || 0);
    let amount  = (dtype === 'percent') ? (eligibleSubtotal * dval / 100) : dval;
    if (c.max_discount_amount != null) amount = Math.min(amount, Number(c.max_discount_amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS coupon_ledger (
        id BIGSERIAL PRIMARY KEY,
        store_id TEXT NOT NULL,
        code TEXT NOT NULL,
        applied_amount NUMERIC NOT NULL CHECK (applied_amount >= 0),
        currency TEXT NOT NULL DEFAULT 'ARS',
        checkout_id TEXT,
        order_id TEXT,
        customer_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_ledger_store_code_checkout
        ON coupon_ledger (store_id, code, checkout_id);
    `);

    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(applied_amount),0) AS used FROM coupon_ledger WHERE store_id = $1 AND code = $2`,
      [store_id, code]
    );
    const used = Number(sumRows[0]?.used || 0);
    const cap = (c.cap_total_amount != null ? Number(c.cap_total_amount)
           : (c.monthly_cap_amount != null ? Number(c.monthly_cap_amount) : null));

    let cappedAmount = amount;
    if (cap != null && cap >= 0) {
      const remaining = Math.max(0, cap - used);
      if (remaining <= 0) {
        return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
      }
      cappedAmount = Math.min(amount, remaining);
    }

    const checkout_id2 = String(body.checkout_id || body.checkout_token || body.token || "").trim();
    if (checkout_id2) {
      await pool.query(
        `INSERT INTO coupon_ledger (store_id, code, applied_amount, currency, checkout_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_id, code, checkout_id) DO UPDATE SET applied_amount = EXCLUDED.applied_amount`,
        [store_id, code, cappedAmount, currency, checkout_id2]
      );
    }

    const label = c.label || `Cupón ${code}`;
    return res.json({
      commands: [{
        command: "create_or_update_discount",
        specs: {
          promotion_id: PROMO_ID,
          currency,
          display_text: { "es-ar": label },
          discount_specs: { type: "fixed", amount: cappedAmount.toFixed(2) }
        }
      }]
    });
  } catch (e) {
    console.error("discounts/callback error:", e);
    return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
  }
});

app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

// -------------------- Start --------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log("Server on :" + PORT));
