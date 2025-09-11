// server.js — App Merci Descuentos (TN OAuth + Neon + Campañas c/ categorías)
// ESM + Render estable. Incluye /api/health, /api/db/ping y /api/db/migrate.

import express from "express";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";      // única carga de variables .env
import { Pool } from "pg";

// -------------------- DB (Neon) --------------------
const { DATABASE_URL } = process.env;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: "sess",
    secret: process.env.SESSION_SECRET || "dev",
    httpOnly: true,
    sameSite: "lax",
  })
);

// -------------------- Salud --------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    data: { status: "ok", node: process.version, time: new Date().toISOString() },
  });
});

// DB ping (opcional)
app.get("/api/db/ping", async (_req, res) => {
  if (!pool) return res.json({ ok: false, error: "DATABASE_URL no configurada" });
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- MIGRACIONES (crear tablas) --------------------
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

    -- Compatibilidad con validaciones previas
    type TEXT NOT NULL CHECK (type IN ('percentage','absolute')),
    value INTEGER NOT NULL,

    -- Modelo nuevo (UI)
    discount_type TEXT,
    discount_value NUMERIC,

    valid_from DATE,
    valid_until DATE,
    apply_scope TEXT DEFAULT 'all',
    min_cart_amount NUMERIC DEFAULT 0,
    max_discount_amount NUMERIC,
    monthly_cap_amount NUMERIC,
    exclude_sale_items BOOLEAN DEFAULT false,

    -- Legacy (compatibilidad)
    min_cart INTEGER DEFAULT 0,
    monthly_cap INTEGER DEFAULT 0,
    exclude_on_sale BOOLEAN DEFAULT false,
    start_date DATE,
    end_date DATE,

    -- Segmentación
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
  try {
    await pool.query(MIGRATE_SQL);
    res.json({ ok: true, message: "Migraciones aplicadas" });
  } catch (e) {
    console.error("MIGRATE error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Raíz simple
app.get("/", (_req, res) => res.send("OK"));

// -------------------- Install/OAuth (URL correcta con app_id en el path) --------------------
app.get("/install", (req, res) => {
  const appId = process.env.TN_CLIENT_ID;
  if (!appId) return res.status(500).send("Falta TN_CLIENT_ID en variables de entorno");

  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;

  // Tiendanube: el inicio de instalación es /apps/{app_id}/authorize
  // (si no está logueado, primero te pide login; después muestra permisos)
  const url = `https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");

    // <-- cambio acá: tolerar falta de session.state en reautorización directa
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

// -------------------- API Tiendanube: categorías --------------------
app.get("/api/tn/categories", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });

    const r = await pool.query(
      "SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1",
      [store_id]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ message: "No hay token para esa tienda" });
    }
    const token = r.rows[0].access_token;

    // Tiendanube: Authentication: bearer <token>  + User-Agent obligatorio
    const resp = await axios.get(`https://api.tiendanube.com/v1/${store_id}/categories`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
        "Authentication": `bearer ${token}`,
      },
      params: { per_page: 250 },
    });

    // Normalizar nombre segun idioma
    const cats = (resp.data || []).map((c) => ({
      id: c.id,
      name: c.name?.es || c.name?.pt || c.name?.en || String(c.id),
    }));

    return res.json(cats);
  } catch (e) {
    console.error("GET /api/tn/categories error:", e.response?.data || e.message);
    const status = e.response?.status || 500;
    return res
      .status(status)
      .json({ message: "Error obteniendo categorías", detail: e.response?.data || e.message });
  }
});

// ---------------- Registrar callback de descuentos (TN) ----------------
// ---------------- Registrar callback de descuentos (TN) ----------------
app.all("/api/tn/register-callback", async (req, res) => {
  try {
    const store_id = String((req.body && req.body.store_id) || req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });

    // buscamos el token guardado para esa tienda
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: "No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const callbackUrl = `${process.env.APP_BASE_URL}/discounts/callback`;

    // Tiendanube: PUT /{store_id}/discounts/callbacks
    const resp = await axios.put(
      `https://api.tiendanube.com/v1/${store_id}/discounts/callbacks`,
      { url: callbackUrl },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
          "Authentication": `bearer ${token}`,
        },
        timeout: 8000,
      }
    );

    return res.json({ ok: true, data: resp.data || null, url: callbackUrl });
  } catch (e) {
    console.error("register-callback error:", e.response?.data || e.message);
    const status = e.response?.status || 500;
    return res.status(status).json({ ok: false, error: e.response?.data || e.message });
  }
});

// --- TN: crear promoción base para habilitar callbacks ---
// --- TN: crear promoción base para habilitar callbacks ---
app.get("/api/tn/promotions/register-base", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    // buscar token de esa tienda
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const url = `https://api.tiendanube.com/v1/${store_id}/promotions`;

    // ✅ cuerpo correcto: sin tier ni status, con allocation_type
    const body = {
      name: "Merci Engine – Base",
      allocation_type: "cross_items" // 'cross_items' | 'line_item' | 'shipping_line'
    };

    const resp = await axios.post(url, body, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
        "Authentication": `bearer ${token}`
      }
    });

    return res.json({ ok:true, data: resp.data });
  } catch (e) {
    console.error("register promotion error:", e.response?.data || e.message);
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});


// -------------------- Admin (HTML con formulario) --------------------
app.get("/admin", async (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // IMPORTANTE: no usamos backticks en el <script> para evitar ${} y `
  return res.end(
    "<!doctype html>\n" +
    "<html lang=\"es\">\n" +
    "<head>\n" +
    "<meta charset=\"utf-8\"/>\n" +
    "<title>Cupones Merci</title>\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"/>\n" +
    "<style>\n" +
    "  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial;padding:24px;max-width:980px;margin:auto;background:#fafafa;color:#111}\n" +
    "  h1{margin:0 0 8px}\n" +
    "  .card{background:#fff;border:1px solid #eee;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.04);padding:16px;margin:16px 0}\n" +
    "  label{display:block;font-size:12px;color:#555;margin-top:10px}\n" +
    "  input,select,textarea{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;margin-top:6px}\n" +
    "  .row{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}\n" +
    "  .row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}\n" +
    "  button{background:#111;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}\n" +
    "  table{width:100%;border-collapse:collapse;margin-top:12px}\n" +
    "  th,td{border-bottom:1px solid #eee;text-align:left;padding:8px}\n" +
    "  .muted{color:#666}\n" +
    "  .multi{min-height:120px}\n" +
    "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <h1>Cupones Merci " + (store_id ? ("&mdash; <small class=\"muted\">Tienda <code>" + store_id + "</code></small>") : "") + "</h1>\n" +
    "  <p class=\"muted\">Crear y segmentar campañas por categorías.</p>\n" +
    "\n" +
    "  <div class=\"card\">\n" +
    "    <h3>Nueva campaña</h3>\n" +
    "    <form id=\"f\">\n" +
    "      <div class=\"row\">\n" +
    "        <div>\n" +
    "          <label>Store ID</label>\n" +
    "          <input name=\"store_id\" value=\"" + (store_id || "") + "\" required />\n" +
    "        </div>\n" +
    "        <div>\n" +
    "          <label>Código del cupón</label>\n" +
    "          <input name=\"code\" placeholder=\"EJ: GIMNASIO10\" required />\n" +
    "        </div>\n" +
    "      </div>\n" +
    "\n" +
    "      <label>Nombre interno</label>\n" +
    "      <input name=\"name\" placeholder=\"EJ: Convenio Gimnasios 10%\" required />\n" +
    "\n" +
    "      <div class=\"row\">\n" +
    "        <div>\n" +
    "          <label>Tipo de descuento</label>\n" +
    "          <select name=\"discount_type\">\n" +
    "            <option value=\"percent\" selected>%</option>\n" +
    "            <option value=\"fixed\">Monto fijo</option>\n" +
    "          </select>\n" +
    "        </div>\n" +
    "        <div>\n" +
    "          <label>Valor</label>\n" +
    "          <input name=\"discount_value\" type=\"number\" step=\"1\" value=\"10\" required />\n" +
    "        </div>\n" +
    "      </div>\n" +
    "\n" +
    "      <div class=\"row\">\n" +
    "        <div>\n" +
    "          <label>Vigencia desde</label>\n" +
    "          <input name=\"valid_from\" type=\"date\" required />\n" +
    "        </div>\n" +
    "        <div>\n" +
    "          <label>Vigencia hasta</label>\n" +
    "          <input name=\"valid_until\" type=\"date\" required />\n" +
    "        </div>\n" +
    "      </div>\n" +
    "\n" +
    "      <div class=\"row3\">\n" +
    "        <div>\n" +
    "          <label>Ámbito</label>\n" +
    "          <select name=\"apply_scope\" id=\"apply_scope\">\n" +
    "            <option value=\"all\" selected>Toda la tienda</option>\n" +
    "            <option value=\"categories\">Categorías incluidas</option>\n" +
    "            <option value=\"products\">Productos (próximo)</option>\n" +
    "          </select>\n" +
    "        </div>\n" +
    "        <div>\n" +
    "          <label>Mínimo carrito</label>\n" +
    "          <input name=\"min_cart_amount\" type=\"number\" step=\"1\" value=\"0\" />\n" +
    "        </div>\n" +
    "        <div>\n" +
    "          <label>Excluir productos en oferta</label>\n" +
    "          <select name=\"exclude_sale_items\">\n" +
    "            <option value=\"false\" selected>No</option>\n" +
    "            <option value=\"true\">Sí</option>\n" +
    "          </select>\n" +
    "        </div>\n" +
    "      </div>\n" +
    "\n" +
    "      <div id=\"cats_block\" style=\"display:none\">\n" +
    "        <label>Categorías para incluir (Ctrl/Cmd + clic para múltiples)</label>\n" +
    "        <select id=\"include_categories\" class=\"multi\" multiple></select>\n" +
    "\n" +
    "        <label style=\"margin-top:12px\">Categorías a excluir</label>\n" +
    "        <select id=\"exclude_categories\" class=\"multi\" multiple></select>\n" +
    "      </div>\n" +
    "\n" +
    "      <div style=\"margin-top:12px;display:flex;gap:10px\">\n" +
    "        <button type=\"submit\">Crear campaña</button>\n" +
    "        <button type=\"button\" id=\"reload\">Actualizar lista</button>\n" +
    "      </div>\n" +
    "    </form>\n" +
    "    <div id=\"msg\" class=\"muted\" style=\"margin-top:8px\"></div>\n" +
    "  </div>\n" +
    "\n" +
    "  <div class=\"card\">\n" +
    "    <h3>Campañas existentes</h3>\n" +
    "    <div id=\"list\" class=\"muted\">Cargando…</div>\n" +
    "  </div>\n" +
    "\n" +
    "<script>\n" +
    "const $ = function(s, el){ return (el||document).querySelector(s); };\n" +
    "function toBool(v){ return String(v) === 'true'; }\n" +
    "function selectedIds(sel){ return Array.from(sel.selectedOptions).map(function(o){ return Number(o.value); }); }\n" +
    "function formToPayload(form){\n" +
    "  var fd = new FormData(form);\n" +
    "  var payload = {\n" +
    "    store_id: fd.get('store_id'),\n" +
    "    code: fd.get('code'),\n" +
    "    name: fd.get('name'),\n" +
    "    discount_type: fd.get('discount_type'),\n" +
    "    discount_value: Number(fd.get('discount_value')),\n" +
    "    valid_from: fd.get('valid_from'),\n" +
    "    valid_until: fd.get('valid_until'),\n" +
    "    apply_scope: fd.get('apply_scope'),\n" +
    "    min_cart_amount: Number(fd.get('min_cart_amount') || 0),\n" +
    "    exclude_sale_items: toBool(fd.get('exclude_sale_items'))\n" +
    "  };\n" +
    "  if (payload.apply_scope === 'categories') {\n" +
    "    payload.include_category_ids = selectedIds($('#include_categories'));\n" +
    "    payload.exclude_category_ids = selectedIds($('#exclude_categories'));\n" +
    "  }\n" +
    "  return payload;\n" +
    "}\n" +
    "function api(path, opts){ return fetch(path, opts).then(function(r){ return r.json().then(function(d){ if(!r.ok) throw d; return d; }); }); }\n" +
    "function listCampaigns(sid){ return api('/api/campaigns?store_id='+encodeURIComponent(sid)); }\n" +
    "function fetchCategories(sid){ return api('/api/tn/categories?store_id='+encodeURIComponent(sid)); }\n" +
    "function renderList(rows){\n" +
    "  if(!rows || rows.length === 0){ $('#list').innerHTML = '<p class=\"muted\">No hay campañas.</p>'; return; }\n" +
    "  var html = '<table><thead><tr>' +\n" +
    "             '<th>Nombre</th><th>Código</th><th>Tipo</th><th>Valor</th><th>Ámbito</th><th>Vigencia</th>' +\n" +
    "             '</tr></thead><tbody>';\n" +
    "  html += rows.map(function(r){\n" +
    "    var val = r.discount_type === 'percent' ? (r.discount_value + '%') : ('$' + r.discount_value);\n" +
    "    return '<tr>' +\n" +
    "           '<td>' + r.name + '</td>' +\n" +
    "           '<td><code>' + r.code + '</code></td>' +\n" +
    "           '<td>' + r.discount_type + '</td>' +\n" +
    "           '<td>' + val + '</td>' +\n" +
    "           '<td>' + r.apply_scope + '</td>' +\n" +
    "           '<td>' + r.valid_from + ' → ' + r.valid_until + '</td>' +\n" +
    "           '</tr>';\n" +
    "  }).join('');\n" +
    "  html += '</tbody></table>';\n" +
    "  $('#list').innerHTML = html;\n" +
    "}\n" +
    "function refresh(){\n" +
    "  var sid = document.querySelector('input[name=store_id]').value.trim();\n" +
    "  if(!sid){ $('#list').innerHTML = '<p class=\"muted\">Ingresá Store ID arriba.</p>'; return; }\n" +
    "  $('#list').textContent = 'Cargando…';\n" +
    "  listCampaigns(sid).then(function(data){ renderList(data); })\n" +
    "  .catch(function(){ $('#list').innerHTML = '<p class=\"muted\">Error cargando campañas.</p>'; });\n" +
    "}\n" +
    "function maybeLoadCats(){\n" +
    "  var scope = document.querySelector('#apply_scope').value;\n" +
    "  var block = document.querySelector('#cats_block');\n" +
    "  if(scope !== 'categories'){ block.style.display = 'none'; return; }\n" +
    "  block.style.display = 'block';\n" +
    "  var sid = document.querySelector('input[name=store_id]').value.trim();\n" +
    "  if(!sid){ document.querySelector('#msg').textContent = 'Ingresá Store ID para cargar categorías'; return; }\n" +
    "  document.querySelector('#msg').textContent = 'Cargando categorías…';\n" +
    "  fetchCategories(sid).then(function(cats){\n" +
    "    var inc = document.querySelector('#include_categories');\n" +
    "    var exc = document.querySelector('#exclude_categories');\n" +
    "    inc.innerHTML = cats.map(function(c){ return '<option value=\"'+c.id+'\">'+c.name+'</option>'; }).join('');\n" +
    "    exc.innerHTML = cats.map(function(c){ return '<option value=\"'+c.id+'\">'+c.name+'</option>'; }).join('');\n" +
    "    document.querySelector('#msg').textContent = '';\n" +
    "  }).catch(function(){ document.querySelector('#msg').textContent = 'No se pudieron cargar categorías'; });\n" +
    "}\n" +
    "document.querySelector('#apply_scope').addEventListener('change', maybeLoadCats);\n" +
    "document.querySelector('#f').addEventListener('submit', function(ev){\n" +
    "  ev.preventDefault();\n" +
    "  document.querySelector('#msg').textContent = 'Creando…';\n" +
    "  var payload = formToPayload(ev.target);\n" +
    "  api('/api/campaigns', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })\n" +
    "    .then(function(){ document.querySelector('#msg').textContent = 'Campaña creada ✅'; refresh(); })\n" +
    "    .catch(function(e){ document.querySelector('#msg').textContent = 'Error: ' + (e.detail || e.message || 'No se pudo crear'); });\n" +
    "});\n" +
    "document.querySelector('#reload').addEventListener('click', refresh);\n" +
    "window.addEventListener('load', function(){ refresh(); });\n" +
    "</script>\n" +
    "</body>\n" +
    "</html>\n"
  );
});

// -------------------- API: listar campañas --------------------
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

// -------------------- API: crear campaña (FIX JSONB) --------------------
app.post("/api/campaigns", async (req, res) => {
  try {
    const b = req.body || {};

    const store_id = String(b.store_id || "").trim();
    const code = String(b.code || "").trim();
    const name = String(b.name || "").trim();
    if (!store_id || !code || !name) {
      return res.status(400).json({ message: "Faltan store_id, code o name" });
    }

    const discount_type = (b.discount_type || "percent").toLowerCase(); // 'percent' | 'fixed'
    const discount_value_num = Number(b.discount_value ?? 0);

    // Cumplir CHECK(type): 'percentage' | 'absolute'
    const type = discount_type === "percent" ? "percentage" : "absolute";
    const value = Number.isFinite(discount_value_num) ? Math.round(discount_value_num) : 0;

    const valid_from = b.valid_from || new Date().toISOString().slice(0,10);
    const valid_until = b.valid_until || new Date().toISOString().slice(0,10);
    const apply_scope = (b.apply_scope || "all").toString();

    const min_cart_amount   = b.min_cart_amount   !== undefined ? Number(b.min_cart_amount)   : 0;
    const max_discount_amount = b.max_discount_amount !== undefined ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount = b.monthly_cap_amount !== undefined ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true ? true : false;

    // Segmentación -> JSONB (IMPORTANTE: stringificar)
    const include_category_ids = Array.isArray(b.include_category_ids) && b.include_category_ids.length
      ? JSON.stringify(b.include_category_ids.map(Number))
      : null;
    const exclude_category_ids = Array.isArray(b.exclude_category_ids) && b.exclude_category_ids.length
      ? JSON.stringify(b.exclude_category_ids.map(Number))
      : null;
    const include_product_ids = Array.isArray(b.include_product_ids) && b.include_product_ids.length
      ? JSON.stringify(b.include_product_ids.map(Number))
      : null;
    const exclude_product_ids = Array.isArray(b.exclude_product_ids) && b.exclude_product_ids.length
      ? JSON.stringify(b.exclude_product_ids.map(Number))
      : null;

    // Legacy obligatorios con defaults
    const min_cart     = b.min_cart     != null ? Number(b.min_cart)     : 0;
    const monthly_cap  = b.monthly_cap  != null ? Number(b.monthly_cap)  : 0;
    const exclude_on_sale = b.exclude_on_sale != null ? !!b.exclude_on_sale : false;
    const status = "active";

    const sql = `
      INSERT INTO campaigns (
        id,
        store_id, name, code,
        type, value, min_cart, monthly_cap,
        start_date, end_date,
        exclude_on_sale, status,
        created_at, updated_at,
        discount_type, discount_value,
        max_uses_per_coupon, max_uses_per_customer,
        valid_from, valid_until, apply_scope,
        min_cart_amount, max_discount_amount, monthly_cap_amount,
        exclude_sale_items,
        include_category_ids, exclude_category_ids,
        include_product_ids,  exclude_product_ids
      ) VALUES (
        gen_random_uuid(),
        $1, $2, $3,
        $4, $5, $6, $7,
        NULL, NULL,
        $8, $9,
        now(), now(),
        $10, $11,
        NULL, NULL,
        $12, $13, $14,
        $15, $16, $17,
        $18,
        $19::jsonb, $20::jsonb,
        $21::jsonb, $22::jsonb
      )
      RETURNING id, store_id, code, name, created_at
    `;

    const params = [
      store_id,
      name,
      code,
      type,
      value,
      min_cart,
      monthly_cap,
      exclude_on_sale,
      status,
      discount_type,
      discount_value_num,
      valid_from,
      valid_until,
      apply_scope,
      min_cart_amount,
      max_discount_amount,
      monthly_cap_amount,
      exclude_sale_items,
      include_category_ids,
      exclude_category_ids,
      include_product_ids,
      exclude_product_ids
    ];

    const r = await pool.query(sql, params);
    return res.json({ ok: true, campaign: r.rows[0] });
  } catch (e) {
    console.error("POST /api/campaigns error:", e);
    return res.status(500).json({
      message: "Error al crear campaña",
      detail: e.detail || e.message
    });
  }
});

// -------------------- Placeholders seguros --------------------
// -------------------- Discounts Callback (aplica campañas por cupón) --------------------
app.post("/discounts/callback", async (req, res) => {
  try {
    const body = req.body || {};
    const store_id = String(body.store_id || "").trim();
    const coupons = Array.isArray(body.coupons) ? body.coupons : [];
    if (!store_id || coupons.length === 0) return res.sendStatus(204); // sin cupón → no acción

    // Usamos el primer cupón
    const code = String(coupons[0] || "").trim().toUpperCase();

    // Buscamos campaña activa por código y tienda
    const q = await pool.query(
      `SELECT *
         FROM campaigns
        WHERE store_id = $1
          AND UPPER(code) = $2
          AND status = 'active'
        LIMIT 1`,
      [store_id, code]
    );
    if (q.rowCount === 0) return res.sendStatus(204);

    const camp = q.rows[0];

    // Vigencia (YYYY-MM-DD)
    const today = new Date().toISOString().slice(0,10);
    if ((camp.valid_from && today < camp.valid_from) ||
        (camp.valid_until && today > camp.valid_until)) {
      return res.sendStatus(204);
    }

    const products = Array.isArray(body.products) ? body.products : [];

    // Total elegible según ámbito/categorías
    let eligibleSubtotal = 0;
    for (const p of products) {
      const price = Number(p.price || 0);
      const qty   = Number(p.quantity || 0);
      let eligible = true;

      if (camp.apply_scope === 'categories') {
        // IDs de categorías del producto (incluyendo subcategorías)
        const catIds = [];
        if (Array.isArray(p.categories)) {
          for (const c of p.categories) {
            if (c && c.id != null) catIds.push(Number(c.id));
            if (Array.isArray(c.subcategories)) {
              for (const sid of c.subcategories) catIds.push(Number(sid));
            }
          }
        }
        // Campos pueden venir como JSONB (objeto/array) o string JSON
        const parseJsonb = (v) => (Array.isArray(v) ? v
          : (v ? JSON.parse(v) : null));
        const inc = parseJsonb(camp.include_category_ids) || [];
        const exc = parseJsonb(camp.exclude_category_ids) || [];

        const matchesInc = inc.length === 0 ? true : catIds.some(id => inc.includes(id));
        const matchesExc = exc.length > 0   ? catIds.some(id => exc.includes(id)) : false;

        eligible = matchesInc && !matchesExc;
      }

      if (eligible) eligibleSubtotal += price * qty;
    }

    // Mínimo de carrito (si existe)
    if (camp.min_cart_amount && eligibleSubtotal < Number(camp.min_cart_amount)) {
      return res.sendStatus(204);
    }

    if (eligibleSubtotal <= 0) return res.sendStatus(204);

    // Calcular monto final (siempre devolvemos "fixed" según especificación)
    const dtype = String(camp.discount_type || 'percent').toLowerCase();
    const dval  = Number(camp.discount_value || 0);
    let amount  = 0;

    if (dtype === 'percent') {
      amount = eligibleSubtotal * dval / 100;
    } else {
      amount = dval;
    }

    // Tope máximo (si existe)
    if (camp.max_discount_amount != null) {
      amount = Math.min(amount, Number(camp.max_discount_amount));
    }

    // Nada que aplicar
    if (!Number.isFinite(amount) || amount <= 0) return res.sendStatus(204);

    const currency = body.currency || 'ARS';
    const promotion_id = `merci-${store_id}-${code}`; // ID estable por cupón
    const response = {
      commands: [{
        command: "create_or_update_discount",
        specs: {
          promotion_id,
          currency,
          display_text: { "es-ar": `Cupón ${code}` },
          // Descuento a nivel carrito (cross items)
          discount_specs: {
            type: "fixed",
            amount: amount.toFixed(2)
          }
        }
      }]
    };

    return res.json(response);
  } catch (e) {
    console.error("discounts/callback error:", e);
    // Ante error, responder sin acciones (requisito de la API)
    return res.sendStatus(204);
  }
});

app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

// -------------------- Start --------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log("Server on :" + PORT));
