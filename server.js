// server.js — App Merci Descuentos (OAuth + Neon/Postgres + Campañas, con diagnóstico en POST)

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import { URLSearchParams } from "url";
import pool from "./db.js"; // conexión a Neon/Postgres

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

const { TN_CLIENT_ID, TN_CLIENT_SECRET, APP_BASE_URL } = process.env;

// ------------------------------
// Salud
// ------------------------------
app.get("/", (_req, res) => {
  res.send("OK");
});

// ------------------------------
// Helpers DB
// ------------------------------
async function tokenExists(store_id) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM stores WHERE store_id = $1 LIMIT 1",
    [String(store_id)]
  );
  return rowCount > 0;
}

// ------------------------------
// OAuth callback
// ------------------------------
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
      console.warn("No se recibió store_id/user_id en token. Redirigiendo a /admin genérico.");
      return res.redirect(`/admin`);
    }

    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (store_id) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           updated_at = NOW()`,
      [sid, access_token]
    );

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth");
  }
});

// ------------------------------
// Admin mínimo (lee estado desde DB)
// ------------------------------
app.get("/admin", async (req, res) => {
  const { store_id } = req.query;
  let hasToken = false;
  let campaigns = [];

  if (store_id) {
    try {
      hasToken = await tokenExists(store_id);
      const { rows } = await pool.query(
        `SELECT id, code, name, status, discount_type, discount_value,
                valid_from, valid_until, apply_scope, monthly_cap_amount
         FROM campaigns
         WHERE store_id = $1
         ORDER BY created_at DESC`,
        [store_id]
      );
      campaigns = rows;
    } catch (e) {
      console.error("DB admin error:", e.message);
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada ${store_id ? `para la tienda: <code>${store_id}</code>` : ""}</h1>
  <p>${hasToken ? "Token guardado (DB) ✔️" : "Sin token. Reinstalá desde /install"}</p>
  <hr/>
  <h2>Campañas</h2>
  ${campaigns.length === 0
    ? "<p>No hay campañas aún.</p>"
    : `<ul>` + campaigns.map(c =>
        `<li>
          <b>${c.name}</b> <code>${c.code}</code> — ${c.status}
          (${c.discount_type === 'percent' ? c.discount_value + '%' : '$' + c.discount_value})
          <br/>Vigencia: ${c.valid_from} → ${c.valid_until}
          <br/>Ámbito: ${c.apply_scope}${c.monthly_cap_amount ? ` — Tope mensual: $${c.monthly_cap_amount}` : ""}
        </li>`
      ).join("") + `</ul>`
  }
  <p>Próximo paso: formulario para crear nuevas campañas desde la UI.</p>
</body></html>`);
});

// ------------------------------
// Endpoints de campañas
// ------------------------------

/**
 * GET /api/campaigns?store_id=XXXX
 */
app.get("/api/campaigns", async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).send("Falta store_id");

    const { rows } = await pool.query(
      `SELECT id, store_id, code, name, status,
              discount_type, discount_value,
              max_uses_per_coupon, max_uses_per_customer,
              valid_from, valid_until,
              apply_scope, min_cart_amount, max_discount_amount,
              monthly_cap_amount, exclude_sale_items,
              created_at, updated_at
       FROM campaigns
       WHERE store_id = $1
       ORDER BY created_at DESC`,
      [store_id]
    );

    res.json(rows);
  } catch (e) {
    console.error("GET /api/campaigns error:", e.message);
    res.status(500).send("Error al obtener campañas");
  }
});

/**
 * POST /api/campaigns — crea campaña
 */
app.post("/api/campaigns", async (req, res) => {
  try {
    const {
      store_id,
      code,
      name,
      // 👇 NUEVO: campaign type (por defecto 'coupon')
      type = "coupon",

      discount_type,
      discount_value,
      max_uses_per_coupon,
      max_uses_per_customer,
      valid_from,
      valid_until,
      apply_scope = "all",
      min_cart_amount,
      max_discount_amount,
      monthly_cap_amount,
      exclude_sale_items = false,
      status = "active",
    } = req.body;

    if (!store_id || !code || !name || !discount_type || discount_value == null || !valid_from || !valid_until) {
      return res.status(400).send("Faltan campos obligatorios");
    }

    const { rows } = await pool.query(
      `INSERT INTO campaigns (
         store_id, code, name, status, type,
         discount_type, discount_value,
         max_uses_per_coupon, max_uses_per_customer,
         valid_from, valid_until,
         apply_scope, min_cart_amount, max_discount_amount,
         monthly_cap_amount, exclude_sale_items
       )
       VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,
         $8,$9,
         $10,$11,
         $12,$13,$14,
         $15,$16
       )
       RETURNING *`,
      [
        String(store_id),
        String(code),
        String(name),
        String(status),
        String(type),                 // 👈 ahora enviamos type
        String(discount_type),
        Number(discount_value),
        max_uses_per_coupon ?? null,
        max_uses_per_customer ?? null,
        valid_from,
        valid_until,
        String(apply_scope),
        min_cart_amount ?? null,
        max_discount_amount ?? null,
        monthly_cap_amount ?? null,
        Boolean(exclude_sale_items),
      ]
    );

    return res.json(rows[0]);
  } catch (e) {
    console.error("POST /api/campaigns error:", e);
    if (e.code === "23505") {
      return res.status(409).json({ message: "El código de campaña ya existe en esta tienda", code: e.code });
    }
    return res.status(500).json({
      message: "Error al crear campaña",
      code: e.code,
      detail: e.detail,
      hint: e.hint,
      table: e.table,
      column: e.column,
      constraint: e.constraint,
    });
  }
});

// ------------------------------
// Placeholders (webhooks / discounts)
// ------------------------------
app.post("/discounts/callback", (_req, res) => {
  return res.json({ discounts: [] });
});

app.post("/webhooks/orders/create", (_req, res) => {
  return res.sendStatus(200);
});

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
