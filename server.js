// server.js — App Merci Descuentos (TN OAuth + Neon + Campañas c/ categorías)
// ESM + Render estable. Incluye /api/health, /api/db/ping y /api/db/migrate.
// server.js — App Merci Descuentos (TN OAuth + Neon + Campañas c/ categorías)
// ESM + Render estable. Incluye /api/health, /api/db/ping y /api/db/migrate.
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

import express from "express";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";
import { Pool } from "pg";
import cors from "cors";

const PROMO_ID = process.env.TN_PROMO_ID || "1c508de3-84a0-4414-9c75-c2aee4814fcd";

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
app.use('/widget', express.static('public'));
const adminDist = path.join(__dirname, 'admin', 'dist');
app.use('/admin', express.static(adminDist));
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(adminDist, 'index.html'));
});

// ...
app.use(cors()); // habilita requests desde el Checkout a tu API

app.use(
  cookieSession({
    name: "sess",
    secret: process.env.SESSION_SECRET || "dev",
    httpOnly: true,
    sameSite: "lax",
  })
);

// Servir el widget desde /widget/...
app.use(
  "/widget",
  express.static(path.join(__dirname, "public"), { maxAge: "1h" })
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

// DEBUG: ver tiendas guardadas (últimas 5)
app.get("/api/debug/stores", async (_req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok:false, error:"DB no configurada" });
    const r = await pool.query(
      "SELECT store_id, created_at FROM stores ORDER BY created_at DESC LIMIT 5"
    );
    res.json({ ok:true, stores: r.rows });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
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
  if (!appId) return res.status(500).send("Falta TN_CLIENT_ID");

  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;

  // AR: dominio www.tiendanube.com
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

// --- DEBUG: listar scripts crudos tal cual responde TN
app.get("/api/tn/scripts/list", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const base = `https://api.tiendanube.com/v1/${store_id}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
      "Authentication": `bearer ${token}`,
    };

    const listRes = await axios.get(`${base}/scripts`, { headers });
    // devolvemos crudo para ver la forma real
    return res.json({ ok:true, raw:listRes.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// --- TN: instalar un script de Partner por ID (manual, no auto-install) ---
app.all("/api/tn/scripts/install-by-id", async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || "").trim();
    const script_id = String((req.body?.script_id) || req.query.script_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    if (!script_id) return res.status(400).json({ ok:false, error:"Falta script_id" });

    // token de la tienda
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const base = `https://api.tiendanube.com/v1/${store_id}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
      "Authentication": `bearer ${token}`,
    };

    // Crea/activa la asociación de ese script en ESTA tienda
    const payload = { script_id: Number(script_id), enabled: true };
    const created = await axios.post(`${base}/scripts`, payload, { headers });
    return res.json({ ok:true, action:"created_by_id", data: created.data });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});


// --- TN: instalar Script del widget en la tienda (checkout/onload) ---
// --- TN: instalar Script del widget en la tienda (checkout/onload) ---
// --- TN: instalar Script del widget en la tienda (checkout/onload) ---
// --- TN: instalar Script del widget en la tienda (checkout/onload) ---
// --- TN: instalar Script del widget en la tienda (checkout/onload) ---
// --- TN: instalar Script definido en Partner por script_id (checkout/onload) ---
app.all("/api/tn/scripts/install", async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    // token de la tienda
    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const base = `https://api.tiendanube.com/v1/${store_id}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
      "Authentication": `bearer ${token}`,
    };

    // 1) Listar scripts disponibles (de tu app) y tomar el nuestro por nombre/id
    const listRes = await axios.get(`${base}/scripts`, { headers });
    const list = Array.isArray(listRes.data?.result) ? listRes.data.result : [];
    const target = list.find(s => String(s?.name || "").toLowerCase().includes("merci checkout widget")) || list[0];
    const scriptId = target?.id || target?.script_id;
    if (!scriptId) return res.status(400).json({ ok:false, error:"No encontré script_id en la lista" });

    // 2) Si ya hay una instalación previa para este script, la habilitamos; si no, lo instalamos
    // (algunas cuentas permiten PUT /scripts/{id} con {script_id, enabled}; otras requieren POST con {script_id})
    try {
      const upd = await axios.put(`${base}/scripts/${scriptId}`, { script_id: scriptId, enabled: true }, { headers });
      return res.json({ ok:true, action:"updated_by_id", data: upd.data });
    } catch {
      const created = await axios.post(`${base}/scripts`, { script_id: scriptId, enabled: true }, { headers });
      return res.json({ ok:true, action:"created_by_id", data: created.data });
    }
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});


// --- TN: instalar/activar un Script por ID (cuando NO es auto-install)
app.all("/api/tn/scripts/install/by-id", async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || "").trim();
    const script_id = String((req.body?.script_id) || req.query.script_id || "").trim();

    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    if (!script_id) return res.status(400).json({ ok:false, error:"Falta script_id" });

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const base = `https://api.tiendanube.com/v1/${store_id}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
      "Authentication": `bearer ${token}`,
    };

    // Intentar actualizar si ya existe la instalación
    try {
      const upd = await axios.put(`${base}/scripts/${script_id}`, { script_id, enabled: true }, { headers });
      return res.json({ ok:true, action:"updated_by_id", data: upd.data });
    } catch (e1) {
      // Si no existe, crear instalación
      try {
        const created = await axios.post(`${base}/scripts`, { script_id, enabled: true }, { headers });
        return res.json({ ok:true, action:"created_by_id", data: created.data });
      } catch (e2) {
        return res.status(e2.response?.status || 500).json({ ok:false, error: e2.response?.data || e2.message });
      }
    }
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// --- TN: instalar script DIRECTO en la tienda (sin script_id del Partner)
app.all("/api/tn/scripts/install/direct", async (req, res) => {
  try {
    const store_id = String(req.body?.store_id || req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    // Podés sobreescribir por query: ?src=URL&name=...&event=onload&location=checkout
    const src = String(req.body?.src || req.query.src || `${process.env.APP_BASE_URL}/widget/merci-checkout-coupon-widget.js`).trim();
    const name = String(req.body?.name || req.query.name || "Merci Checkout Widget (direct)").trim();
    const event = String(req.body?.event || req.query.event || "onload").trim();
    const location = String(req.body?.location || req.query.location || "checkout").trim();

    const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:"No hay token para esa tienda" });
    const token = r.rows[0].access_token;

    const base = `https://api.tiendanube.com/v1/${store_id}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
      "Authentication": `bearer ${token}`,
    };

    const body = { name, src, event, location, enabled: true };
    const created = await axios.post(`${base}/scripts`, body, { headers });
    return res.json({ ok:true, action:"created_direct", data: created.data });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ========= Helpers TN =========
function tnBase(store_id) {
  return `https://api.tiendanube.com/v1/${store_id}`;
}
function tnHeaders(token) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
    "Authentication": `bearer ${token}`,
  };
}
async function getStoreTokenOrThrow(store_id) {
  if (!pool) throw new Error("DB no configurada");
  const r = await pool.query("SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1", [store_id]);
  if (r.rowCount === 0) throw new Error("No hay token para esa tienda");
  return r.rows[0].access_token;
}

// ========= Crear promoción nativa + (opcional) cargar códigos =========
// Crea una promoción "nativa" de TN (ej: 10% con código) y opcionalmente sube una lista de códigos.
app.post("/api/tn/promotions/create-native", async (req, res) => {
  try {
    const {
      store_id,
      name = "Merci – Cupones",
      // descuento:
      discount_type = "percent",         // "percent" | "fixed"
      discount_value = 10,               // número
      // vigencia:
      valid_from = null,                 // ej "2025-09-15"
      valid_until = null,                // ej "2025-12-31"
      // alcance:
      allocation_type = "cross_items",   // 'cross_items' | 'line_item' | 'shipping_line'
      // opcional: crear ya los códigos
      codes = []                         // ['GIMNASIO10', 'BANCO20', ...]
    } = req.body || {};

    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    const token = await getStoreTokenOrThrow(String(store_id).trim());
    const base = tnBase(store_id);
    const headers = tnHeaders(token);

    // 1) Crear promoción
    const promoBody = {
      name,
      allocation_type,         // dónde impacta el descuento
      // El “descuento” suele definirse a nivel promoción:
      discount_type,           // "percent" | "fixed"
      discount_value,          // numérico
      // Fechas (si las pasás, se guardan; si no, quedan abiertas)
      valid_from,
      valid_until
    };

    const createdPromo = await axios.post(`${base}/promotions`, promoBody, { headers });
    const promo = createdPromo.data || {};
    const promotion_id = promo.id;

    // 2) Si mandaron códigos, intentar cargarlos
    let addCodesResult = null;
    if (Array.isArray(codes) && codes.length > 0) {
      addCodesResult = await addCodesRobusto({ base, headers, promotion_id, codes });
    }

    return res.json({
      ok: true,
      promotion: promo,
      added_codes: addCodesResult
    });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ========= Agregar muchos códigos a una promoción existente =========
app.post("/api/tn/promotions/add-codes", async (req, res) => {
  try {
    const { store_id, promotion_id, codes = [] } = req.body || {};
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });
    if (!promotion_id) return res.status(400).json({ ok:false, error:"Falta promotion_id" });
    if (!Array.isArray(codes) || codes.length === 0) return res.status(400).json({ ok:false, error:"Faltan codes[]" });

    const token = await getStoreTokenOrThrow(String(store_id).trim());
    const base = tnBase(store_id);
    const headers = tnHeaders(token);

    const added = await addCodesRobusto({ base, headers, promotion_id, codes });
    return res.json({ ok:true, added });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});

// ========= Listar promociones rápidas =========
app.get("/api/tn/promotions/list", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ ok:false, error:"Falta store_id" });

    const token = await getStoreTokenOrThrow(store_id);
    const base = tnBase(store_id);
    const headers = tnHeaders(token);

    const r = await axios.get(`${base}/promotions`, { headers, params: { per_page: 50 } });
    return res.json({ ok:true, data: r.data });
  } catch (e) {
    const status = e.response?.status || 500;
    return res.status(status).json({ ok:false, error: e.response?.data || e.message });
  }
});

/**
 * addCodesRobusto: intenta varios formatos/rutas porque hay diferencias
 * entre cuentas / versiones. Devuelve el primero que funcione.
 * - Paths probados:
 *   1) /promotions/{id}/codes
 *   2) /promotions/{id}/coupons
 * - Shapes probados:
 *   a) { codes: ["ABC","DEF"] }
 *   b) [{ code: "ABC" }, { code: "DEF" }]
 *   c) { codes: [{ code: "ABC" }, { code: "DEF" }] }
 */
async function addCodesRobusto({ base, headers, promotion_id, codes }) {
  const paths = [
    `/promotions/${promotion_id}/codes`,
    `/promotions/${promotion_id}/coupons`,
  ];
  const shapes = [
    { codes: codes },                                  // { codes: ["A","B"] }
    codes.map(c => ({ code: String(c) })),             // [ {code:"A"}, {code:"B"} ]
    { codes: codes.map(c => ({ code: String(c) })) },  // { codes:[{code:"A"},...] }
  ];

  const tried = [];
  for (const path of paths) {
    for (const body of shapes) {
      try {
        const r = await axios.post(`${base}${path}`, body, { headers });
        return { ok:true, path, body_used: body, response: r.data };
      } catch (e) {
        tried.push({ path, body, error: e.response?.data || e.message });
      }
    }
  }
  return { ok:false, tried };
}


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

// ====== Cupón propio en checkout (guardar / quitar) ======
app.post('/api/checkout/code/set', async (req, res) => {
  try {
    const { checkout_id, code } = req.body || {};
    if (!checkout_id || !code) return res.status(400).json({ ok: false, message: 'checkout_id y code son requeridos' });
    if (!pool) return res.status(500).json({ ok: false, message: 'DB no configurada' });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS checkout_codes (
        checkout_id TEXT PRIMARY KEY,
        code        TEXT NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

    await pool.query(`
      INSERT INTO checkout_codes (checkout_id, code)
      VALUES ($1, $2)
      ON CONFLICT (checkout_id) DO UPDATE SET code = EXCLUDED.code, created_at = now()
    `, [checkout_id, String(code).trim().toUpperCase()]);

    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/checkout/code/set error:', e);
    return res.status(500).json({ ok: false, message: 'error' });
  }
});

app.post('/api/checkout/code/clear', async (req, res) => {
  try {
    const { checkout_id } = req.body || {};
    if (!checkout_id) return res.status(400).json({ ok: false, message: 'checkout_id requerido' });
    if (!pool) return res.status(500).json({ ok: false, message: 'DB no configurada' });

    await pool.query(`DELETE FROM checkout_codes WHERE checkout_id = $1`, [checkout_id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/checkout/code/clear error:', e);
    return res.status(500).json({ ok: false, message: 'error' });
  }
});


// -------------------- Placeholders seguros --------------------
// -------------------- Discounts Callback (aplica campañas por cupón) --------------------
// -------------------- Discounts Callback (smoke test + lógica real) --------------------
// -------------------- Discounts Callback (lógica real, sin smoke) --------------------
// -------------------- Discounts Callback (borra al quitar cupón) --------------------
// -------------------- Discounts Callback (con categorías + borra al quitar cupón) --------------------
// -------------------- Discounts Callback (activo: categorías + borrar si no aplica) --------------------
// -------------------- Discounts Callback (ACTIVO) --------------------
// -------------------- Discounts Callback (usa nuestro código propio) --------------------
// === Discounts Callback (código propio + tope total en $ por cupón, multi-tienda) ===
app.post("/discounts/callback", async (req, res) => {
  try {
    const body = req.body || {};
    const store_id = String(body.store_id || "").trim();
    const currency = body.currency || "ARS";
    if (!store_id || !pool) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // ---- 1) Extraer código desde campos personalizados del checkout (sin nativo)
    const getCodeFromPayload = (b) => {
      // buscamos en varias estructuras comunes del payload de TN
      const tryStr = (v) => (typeof v === "string" ? v.trim() : "");
      // a) arrays de { name, value } o { key, value }
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
      // b) objetos key/value
      const scanObject = (obj) => {
        if (!obj || typeof obj !== "object") return "";
        for (const [k, v] of Object.entries(obj)) {
          const kk = tryStr(k).toLowerCase();
          const vv = tryStr(v);
          if (!kk || !vv) continue;
          if (/(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(kk)) return vv;
        }
        return "";
      };

      // rutas posibles
      return (
        tryStr(b.code) ||
        scanArray(b.custom_fields) ||
        scanArray(b.additional_fields) ||
        scanArray(b.note_attributes) ||
        scanArray(b?.checkout?.custom_fields) ||
        scanArray(b?.checkout?.attributes) ||
        scanObject(b.attributes) ||
        scanObject(b.checkout?.attributes) ||
        ""
      );
    };

    let code = getCodeFromPayload(body).toUpperCase();

    // Fallback (por si usás nuestro widget aún): mapa por checkout_id
    const checkout_id = String(
      body.checkout_id ||
      body.checkout_token ||
      (body.checkout && body.checkout.id) ||
      body.token ||
      ""
    ).trim();

    if (!code && checkout_id) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS checkout_codes (
          checkout_id TEXT PRIMARY KEY,
          code        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT now()
        )
      `);
      const r = await pool.query(`SELECT code FROM checkout_codes WHERE checkout_id = $1 LIMIT 1`, [checkout_id]);
      if (r.rowCount > 0) code = String(r.rows[0].code || "").trim().toUpperCase();
    }

    if (!code) {
      // sin código → no aplicar (tu modelo requiere código)
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // ---- 2) Buscar campaña activa por tienda + código
    const q = await pool.query(
      `SELECT *
         FROM campaigns
        WHERE store_id = $1 AND UPPER(code) = $2 AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1`,
      [store_id, code]
    );
    if (q.rowCount === 0) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }
    const c = q.rows[0];

    // Vigencia (usa valid_from/valid_until si están)
    const today = new Date().toISOString().slice(0,10);
    if ((c.valid_from && today < c.valid_from) || (c.valid_until && today > c.valid_until)) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // ---- 3) Subtotal elegible (categorías incluidas/excluidas si corresponde)
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

    if (eligibleSubtotal <= 0) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // Mínimo de carrito si corresponde
    if (c.min_cart_amount && eligibleSubtotal < Number(c.min_cart_amount)) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // ---- 4) Calcular beneficio bruto de la campaña
    const dtype = String(c.discount_type || 'percent').toLowerCase(); // 'percent' | 'fixed'
    const dval  = Number(c.discount_value || 0);
    let amount  = (dtype === 'percent') ? (eligibleSubtotal * dval / 100) : dval;
    if (c.max_discount_amount != null) {
      amount = Math.min(amount, Number(c.max_discount_amount));
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
    }

    // ---- 5) Topar por tope total en $ (cap_total_amount) usando "libreta" (idempotente por checkout)
    // Tabla de ledger e índice único por (store_id, code, checkout_id)
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

    // Suma aplicada a la fecha
    const { rows: sumRows } = await pool.query(
      `SELECT COALESCE(SUM(applied_amount),0) AS used
         FROM coupon_ledger
        WHERE store_id = $1 AND code = $2`,
      [store_id, code]
    );
    const used = Number(sumRows[0]?.used || 0);
    const cap  = c.cap_total_amount != null ? Number(c.cap_total_amount) : null;

    let cappedAmount = amount;
    if (cap != null && cap >= 0) {
      const remaining = Math.max(0, cap - used);
      if (remaining <= 0) {
        // cupón agotado
        return res.json({ commands: [{ command: "delete_discount", specs: { promotion_id: PROMO_ID } }] });
      }
      cappedAmount = Math.min(amount, remaining);
    }

    // Registrar de manera idempotente por checkout_id (si hay)
    if (checkout_id) {
      await pool.query(
        `INSERT INTO coupon_ledger (store_id, code, applied_amount, currency, checkout_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (store_id, code, checkout_id)
         DO UPDATE SET applied_amount = EXCLUDED.applied_amount`,
        [store_id, code, cappedAmount, currency, checkout_id]
      );
    }

    // ---- 6) Responder con una sola línea de descuento
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
