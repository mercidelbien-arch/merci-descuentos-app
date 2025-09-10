// server.js — App Merci Descuentos (OAuth + Neon/Postgres + Admin mínimo)

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import { URLSearchParams } from "url";
import pool from "./db.js"; // conexión a Neon/Postgres

dotenv.config();

const app = express();
app.set("trust proxy", 1); // cookies detrás de proxy (Render)
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

// ENV requeridas
const { TN_CLIENT_ID, TN_CLIENT_SECRET, APP_BASE_URL } = process.env;
if (!APP_BASE_URL) console.warn("⚠️ Falta APP_BASE_URL en env");
if (!TN_CLIENT_ID || !TN_CLIENT_SECRET) console.warn("⚠️ Falta TN_CLIENT_ID o TN_CLIENT_SECRET");

// ------------------------------
// Helpers DB (guardar / validar token)
// ------------------------------
async function saveStoreToken(store_id, access_token) {
  await pool.query(
    `INSERT INTO stores (store_id, access_token, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (store_id)
     DO UPDATE SET access_token = EXCLUDED.access_token,
                   updated_at = NOW()`,
    [String(store_id), String(access_token)]
  );
}

async function tokenExists(store_id) {
  const { rowCount } = await pool.query(
    "SELECT 1 FROM stores WHERE store_id = $1 LIMIT 1",
    [String(store_id)]
  );
  return rowCount > 0;
}

// ------------------------------
// Salud
// ------------------------------
app.get("/", (_req, res) => {
  res.send("OK");
});

// ------------------------------
// 1) Instalación / OAuth (inicio)
// ------------------------------
app.get("/install", (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).send("Falta store_id");
    if (!TN_CLIENT_ID || !TN_CLIENT_SECRET || !APP_BASE_URL) {
      return res
        .status(500)
        .send("Faltan variables de entorno (TN_CLIENT_ID, TN_CLIENT_SECRET, APP_BASE_URL)");
    }

    const redirect_uri = `${APP_BASE_URL}/oauth/callback`;
    const state = crypto.randomBytes(12).toString("hex");
    req.session.state = state;

    const scopes = "read_products,write_discounts,read_orders";

    const authUrl =
      `https://www.tiendanube.com/apps/${TN_CLIENT_ID}/authorize` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(TN_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirect_uri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(scopes)}`;

    return res.redirect(authUrl);
  } catch (e) {
    console.error("Install error:", e);
    return res.status(500).send("Error en /install");
  }
});

// ------------------------------
// 2) OAuth callback — token x-www-form-urlencoded
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

    console.log("Token response:", tokenRes.data);

    const data = tokenRes.data || {};
    const access_token = data.access_token;
    const sid = String(data.store_id || data.user_id || "").trim(); // algunos entornos devuelven user_id

    if (!access_token) {
      return res.status(400).send("No se recibió token (mirá logs en Render)");
    }

    if (!sid) {
      console.warn("⚠️ No vino store_id/user_id. Redirigiendo a /admin genérico.");
      return res.redirect(`/admin`);
    }

    // Guardar token en DB
    await saveStoreToken(sid, access_token);

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth (mirá logs en Render)");
  }
});

// ------------------------------
// 3) Admin mínimo (lee estado desde DB)
// ------------------------------
app.get("/admin", async (req, res) => {
  const { store_id } = req.query;
  let hasToken = false;

  if (store_id) {
    try {
      hasToken = await tokenExists(store_id);
    } catch (e) {
      console.error("DB admin check error:", e.message);
    }
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada ${store_id ? `para la tienda: <code>${store_id}</code>` : ""}</h1>
  <p>${hasToken ? "Token guardado (DB) ✔️" : "Sin token o store_id. Instalá desde <code>/install?store_id=TU_TIENDA</code>"}</p>
  <hr/>
  <p>Panel mínimo. Próximo paso: UI de campañas/cupones y Discount API.</p>
</body></html>`);
});

// ------------------------------
// 4) Endpoints base (placeholders seguros)
// ------------------------------
app.post("/discounts/callback", (_req, res) => {
  // MVP: no aplicamos descuentos aún
  return res.json({ discounts: [] });
});

app.post("/webhooks/orders/create", (_req, res) => {
  // ACK inmediato
  return res.sendStatus(200);
});

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
