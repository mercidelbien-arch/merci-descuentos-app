// server.js — App Merci Descuentos (MVP OAuth + DB + Campañas)

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import { URLSearchParams } from "url";
import pool from "./db.js"; // <- usa tu db.js con la conexión a Neon

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

/* ---------- HEALTH ---------- */
app.get("/", (_req, res) => res.send("OK"));

/* ---------- OAUTH (instalación) ---------- */
app.get("/install", (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send("Falta store_id");
  const state = crypto.randomBytes(16).toString("hex");
  req.session.state = state;
  const redirect_uri = `${process.env.APP_BASE_URL}/oauth/callback`;
  const url = `https://www.tiendanube.com/apps/authorize?response_type=code&client_id=${process.env.TN_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    redirect_uri
  )}&state=${state}&scope=read_products,write_discounts,read_discounts&store_id=${encodeURIComponent(
    store_id
  )}`;
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");
    if (state !== req.session.state)
      return res.status(400).send("Estado inválido");

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

    // guarda/actualiza token
    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (store_id) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = now()`,
      [sid, access_token]
    );

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth");
  }
});

/* ---------- ADMIN ---------- */
app.get("/admin", async (req, res) => {
  const { store_id } = req.query;
  // chequeo rápido si hay token en DB
  let hasToken = false;
  if (store_id) {
    const r = await pool.query(`SELECT 1 FROM stores WHERE store_id=$1`, [
      String(store_id),
    ]);
    hasToken = r.rowCount > 0;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada para la tienda: ${store_id || "-"}</h1>
  <p>${hasToken ? "Token guardado (DB) ✔️" : "Sin token. Instalá desde <code>/install?store_id=TU_TIENDA</code>"}</p>
  <hr/>
  <p>Panel mínimo. Próximo paso: UI de campañas/cupones y Discount API.</p>
</body></html>`);
});

/* ============================================================================
   API DE CAMPAÑAS
   ==========================================================================*/

/** GET /api/campaigns?store_id=XXXX */
app.get("/api/campaigns", async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.json([]);
    const r = await pool.query(
      `SELECT id, store_id, code, name, created_at
         FROM campaigns
        WHERE store_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [String(store_id)]
    );
    res.json(r.rows);
  } catch (e) {
    console.error("GET /api/campaigns error:", e.message);
    res.status(500).json({ message: "Error listando campañas" });
  }
});

/** POST /api/campaigns
 *  Espera JSON parecido a:
 *  {
 *    store_id, code, name,
 *    discount_type, discount_value,
 *    valid_from, valid_until, apply_scope,
 *    min_cart_amount, max_discount_amount, monthly_cap_amount, exclude_sale_items,
 *    (opcional/legacy) type, value, min_cart, monthly_cap, exclude_on_sale
 *  }
 */
app.post("/api/campaigns", async (req, res) => {
  try {
    const b = req.body || {};

    const store_id = String(b.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });

    const code = String(b.code || `WEB_${Math.floor(Math.random() * 10000)}`);
    const name = String(b.name || "Campaña sin nombre");

    // Campos NUEVOS
    const discount_type = (b.discount_type || "percent").toLowerCase();
    const discount_value = Number(b.discount_value ?? 0);
    const valid_from = b.valid_from ? new Date(b.valid_from) : new Date(); // date
    const valid_until = b.valid_until ? new Date(b.valid_until) : new Date(); // date
    const apply_scope = b.apply_scope || "all";
    const min_cart_amount = b.min_cart_amount != null ? Number(b.min_cart_amount) : 0;
    const max_discount_amount =
      b.max_discount_amount != null ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount =
      b.monthly_cap_amount != null ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true ? true : false;

    // Campos LEGACY (la tabla todavía los tiene y son NOT NULL en parte)
    const type = String(b.type || "coupon"); // si el INSERT lo incluye, que no vaya NULL
    const value = Number(
      b.value != null ? b.value : b.discount_value != null ? b.discount_value : 0
    ); // <- si value es NOT NULL, mapeamos discount_value
    const min_cart = b.min_cart != null ? Number(b.min_cart) : 0; // default
    const monthly_cap = b.monthly_cap != null ? Number(b.monthly_cap) : 0; // default
    const exclude_on_sale = b.exclude_on_sale != null ? !!b.exclude_on_sale : true; // default
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
      RETURNING id, code, name, store_id, created_at
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
      discount_value,
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
    // devolvemos lo que tengamos para que lo veas en el navegador
    return res
      .status(500)
      .json({ message: "Error al crear campaña", detail: e.detail || e.message });
  }
});

/* ---------- DISCOUNTS CALLBACK / WEBHOOKS (placeholders) ---------- */
app.post("/discounts/callback", (_req, res) => res.json({ discounts: [] }));
app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

/* ---------- START ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
