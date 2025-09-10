// server.js — App Merci Descuentos (OAuth + DB + Campaigns API)
// Modo ES Modules (package.json: "type": "module")

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import pkg from "pg";

const { Pool } = pkg;

dotenv.config();

const {
  APP_BASE_URL,
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  SESSION_SECRET,
  DATABASE_URL,
} = process.env;

if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en variables de entorno.");
  process.exit(1);
}

// Pool a Neon (SSL requerido)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: "sess",
    secret: SESSION_SECRET || "dev",
    httpOnly: true,
    sameSite: "lax",
  })
);

// ------------------------------
// Utilidades
// ------------------------------
const makeState = () => crypto.randomBytes(16).toString("hex");

// ------------------------------
// Salud
// ------------------------------
app.get("/", (_req, res) => res.send("OK"));

// ------------------------------
// OAuth (inicio y callback)
// ------------------------------
app.get("/install", (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  if (!store_id) return res.status(400).send("Falta store_id");

  const state = makeState();
  req.session.state = state;

  const redirect_uri = `${APP_BASE_URL}/oauth/callback`;

  const url =
    `https://www.tiendanube.com/apps/authorize?` +
    `client_id=${encodeURIComponent(TN_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code` +
    `&scope=read_products,write_products,read_orders,write_orders`;

  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");
    if (state !== req.session.state) return res.status(400).send("Estado inválido");

    const redirect_uri = `${APP_BASE_URL}/oauth/callback`;

    const form = new URLSearchParams();
    form.append("client_id", TN_CLIENT_ID);
    form.append("client_secret", TN_CLIENT_SECRET);
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

    if (!access_token) {
      console.error("Token response sin access_token:", data);
      return res.status(400).send("No se recibió token");
    }

    if (!sid) {
      console.warn("No llegó store_id/user_id, guardo solo admin mínimo");
      return res.redirect(`/admin`);
    }

    // Guardamos/actualizamos token en tabla stores
    // CREATE TABLE IF NOT EXISTS stores (store_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW());
    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (store_id)
       DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW()`,
      [sid, access_token]
    );

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth");
  }
});

// ------------------------------
// Admin muy simple
// ------------------------------
app.get("/admin", async (req, res) => {
  const { store_id } = req.query;
  let ok = false;
  try {
    if (store_id) {
      const r = await pool.query(`SELECT 1 FROM stores WHERE store_id = $1`, [
        String(store_id),
      ]);
      ok = r.rowCount > 0;
    }
  } catch {}
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada ${store_id ? `para la tienda: <code>${store_id}</code>` : ""}</h1>
  <p>${ok ? "Token guardado en DB ✔️" : "Sin token/store_id. Instalá desde <code>/install?store_id=TU_TIENDA</code>"} </p>
  <hr/>
  <p>Panel mínimo. Próximo paso: UI de campañas/cupones y Discount API.</p>
</body></html>`);
});

// ------------------------------
// API: CAMPAIGNS
// Tabla esperada: campaigns (estructura actual que compartiste)
// ------------------------------

// GET /api/campaigns?store_id=3739596
app.get("/api/campaigns", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.json([]);

    const { rows } = await pool.query(
      `SELECT
         id, store_id, code, name, status,
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
    console.error("Error obteniendo campañas:", err);
    res.status(500).json({ message: "Error al obtener campañas" });
  }
});

// POST /api/campaigns
// Acepta el payload "liviano" y completa defaults para encajar con tu tabla actual.
app.post("/api/campaigns", async (req, res) => {
  try {
    const p = req.body || {};

    // Requeridos mínimos (desde el cliente)
    const store_id = String(p.store_id || "").trim();
    const code = String(p.code || "").trim();
    const name = String(p.name || "").trim();

    if (!store_id || !code || !name) {
      return res.status(400).json({ message: "Faltan store_id, code o name" });
    }

    // Campos “livianos” que llegan del cliente
    const discount_type = (p.discount_type || "percent").toString();
    const discount_value = Number(p.discount_value ?? 0);

    const valid_from = p.valid_from || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const valid_until =
      p.valid_until || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const apply_scope = (p.apply_scope || "all").toString();

    // Opcionales numéricos
    const min_cart_amount =
      p.min_cart_amount !== undefined ? Number(p.min_cart_amount) : null;
    const max_discount_amount =
      p.max_discount_amount !== undefined ? Number(p.max_discount_amount) : null;
    const monthly_cap_amount =
      p.monthly_cap_amount !== undefined ? Number(p.monthly_cap_amount) : null;

    const exclude_sale_items = Boolean(p.exclude_sale_items ?? false);

    // -----------------------------
    // Defaults para TU TABLA actual
    // -----------------------------
    const type = "coupon"; // NOT NULL (default en DB, pero lo envío igual)
    const value = 0; // NOT NULL
    const min_cart = 0; // NOT NULL
    const monthly_cap = 0; // NOT NULL
    const status = "active"; // NOT NULL

    // Insert
    const q = `
      INSERT INTO campaigns (
        store_id, code, name, type, value, min_cart, monthly_cap,
        discount_type, discount_value,
        valid_from, valid_until,
        apply_scope, min_cart_amount, max_discount_amount, monthly_cap_amount,
        exclude_sale_items, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9,
        $10, $11,
        $12, $13, $14, $15,
        $16, $17
      )
      RETURNING
        id, store_id, code, name, status,
        discount_type, discount_value,
        valid_from, valid_until,
        apply_scope, min_cart_amount, max_discount_amount, monthly_cap_amount,
        exclude_sale_items, created_at, updated_at
    `;

    const params = [
      store_id,
      code,
      name,
      type,
      value,
      min_cart,
      monthly_cap,
      discount_type,
      discount_value,
      valid_from,
      valid_until,
      apply_scope,
      min_cart_amount,
      max_discount_amount,
      monthly_cap_amount,
      exclude_sale_items,
      status,
    ];

    const { rows } = await pool.query(q, params);
    return res.json(rows[0]);
  } catch (err) {
    // Intentamos enviar mensaje de Postgres
    console.error("Error creando campaña:", err);
    const pg = err?.detail || err?.message || "Error interno";
    return res.status(500).json({ message: "Error al crear campaña", detail: pg });
  }
});

// ------------------------------
// Discount callbacks / Webhooks (placeholders seguros)
// ------------------------------
app.post("/discounts/callback", (_req, res) => res.json({ discounts: [] }));
app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
