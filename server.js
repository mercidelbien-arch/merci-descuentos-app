// server.js — App Merci Descuentos (OAuth + DB + Campaigns API) — alineado con CHECK(type)

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import { URLSearchParams } from "url";
import pool from "./db.js"; // tu conexión a Neon/Postgres (Pool)

dotenv.config();

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

// ---------------- Salud ----------------
app.get("/", (_req, res) => res.send("OK"));

// ---------------- Install/OAuth ----------------
app.get("/install", (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  if (!store_id) return res.status(400).send("Falta store_id");

  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;

  const redirect_uri = `${process.env.APP_BASE_URL}/oauth/callback`;
  const url =
    `https://www.tiendanube.com/apps/authorize?` +
    `client_id=${encodeURIComponent(process.env.TN_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
    `&state=${encodeURIComponent(state)}` +
    `&response_type=code` +
    `&scope=read_products,write_discounts,read_discounts`;

  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");
    if (state !== req.session.state) return res.status(400).send("Estado inválido");

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

    if (!access_token) {
      console.error("Token sin access_token:", data);
      return res.status(400).send("No se recibió token");
    }

    // Guardamos/actualizamos token
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

// ---------------- Admin mínimo ----------------
app.get("/admin", async (req, res) => {
  const { store_id } = req.query;
  let hasToken = false;

  if (store_id) {
    const r = await pool.query(`SELECT 1 FROM stores WHERE store_id=$1`, [String(store_id)]);
    hasToken = r.rowCount > 0;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada ${store_id ? `para la tienda: <code>${store_id}</code>` : ""}</h1>
  <p>${hasToken ? "Token guardado (DB) ✔️" : "Sin token. Instalá desde <code>/install?store_id=TU_TIENDA</code>"} </p>
  <hr/>
  <p>Panel mínimo. Próximo paso: UI de campañas/cupones y Discount API.</p>
</body></html>`);
});

// ---------------- API Campaigns ----------------

// GET /api/campaigns?store_id=XXXX
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
    console.error("Error obteniendo campañas:", err);
    res.status(500).json({ message: "Error al obtener campañas" });
  }
});

// POST /api/campaigns
app.post("/api/campaigns", async (req, res) => {
  try {
    const b = req.body || {};

    // Requeridos mínimos
    const store_id = String(b.store_id || "").trim();
    const code = String(b.code || "").trim();
    const name = String(b.name || "").trim();
    if (!store_id || !code || !name) {
      return res.status(400).json({ message: "Faltan store_id, code o name" });
    }

    // Nuevos
    const discount_type = (b.discount_type || "percent").toLowerCase(); // 'percent' o 'fixed'
    const discount_value_num = Number(b.discount_value ?? 0);

    // Mapear a legacy type ('percentage'|'absolute') según el CHECK
    const type = discount_type === "percent" ? "percentage" : "absolute";

    // Legacy value INTEGER NOT NULL: derivamos de discount_value
    const value = Number.isFinite(discount_value_num)
      ? Math.round(discount_value_num)
      : 0;

    // Fechas (YYYY-MM-DD)
    const valid_from = b.valid_from || new Date().toISOString().slice(0, 10);
    const valid_until = b.valid_until || new Date().toISOString().slice(0, 10);

    const apply_scope = (b.apply_scope || "all").toString();

    // Nuevos opcionales
    const min_cart_amount =
      b.min_cart_amount !== undefined ? Number(b.min_cart_amount) : 0;
    const max_discount_amount =
      b.max_discount_amount !== undefined ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount =
      b.monthly_cap_amount !== undefined ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true ? true : false;

    // Legacy obligatorios con defaults
    const min_cart = b.min_cart != null ? Number(b.min_cart) : 0;
    const monthly_cap = b.monthly_cap != null ? Number(b.monthly_cap) : 0;
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
        exclude_sale_items
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
        $18
      )
      RETURNING id, store_id, code, name, created_at
    `;

    const params = [
      store_id,
      name,
      code,
      type, // 'percentage' | 'absolute'
      value, // INTEGER
      min_cart,
      monthly_cap,
      exclude_on_sale,
      status,
      discount_type, // 'percent' | 'fixed'
      discount_value_num, // NUMERIC
      valid_from,
      valid_until,
      apply_scope,
      min_cart_amount,
      max_discount_amount,
      monthly_cap_amount,
      exclude_sale_items,
    ];

    const r = await pool.query(sql, params);
    return res.json({ ok: true, campaign: r.rows[0] });
  } catch (e) {
    console.error("POST /api/campaigns error:", e);
    if (e.code === "23505") {
      return res.status(409).json({
        message: "El código de campaña ya existe en esta tienda",
        code: e.code,
        constraint: e.constraint,
      });
    }
    return res.status(500).json({
      message: "Error al crear campaña",
      code: e.code,
      detail: e.detail,
      column: e.column,
      constraint: e.constraint,
      hint: e.hint,
    });
  }
});

// ---------------- Placeholders seguros ----------------
app.post("/discounts/callback", (_req, res) => res.json({ discounts: [] }));
app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
