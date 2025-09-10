// server.js — App Merci Descuentos (MVP OAuth + endpoints base)

import express from "express";
import dotenv from "dotenv";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import { URLSearchParams } from "url";

dotenv.config();

const app = express();
app.set("trust proxy", 1); // para que la cookie de sesión funcione detrás de Render (proxy)
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

// Almacenemos en memoria para probar rápidamente (luego pasamos a Postgres)
const stores = new Map(); // store_id -> { access_token }

// Salud
app.get("/", (_req, res) => {
  res.send("OK");
});

// ----------------------------------------------------------------------------
// 1) Instalación / OAuth (inicio)
// ----------------------------------------------------------------------------
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

    console.log("Token response:", tokenRes.data); // 👈 log para ver qué llega

    const data = tokenRes.data || {};
    const access_token = data.access_token;
    const sid = String(data.store_id || data.user_id || "").trim();

    if (!access_token) {
      return res.status(400).send("No se recibió token (mirá logs en Render)");
    }

    if (!sid) {
      return res.redirect(`/admin`);
    }

    stores.set(sid, { access_token });
    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth (mirá logs en Render)");
  }
});


// ----------------------------------------------------------------------------
// 2) OAuth callback — canjea code por access_token (x-www-form-urlencoded)
// ----------------------------------------------------------------------------
app.get("/oauth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("Callback inválido");
    if (state !== req.session.state) return res.status(400).send("Estado inválido");

    const redirect_uri = `${APP_BASE_URL}/oauth/callback`;

    // Tiendanube espera application/x-www-form-urlencoded
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
    // Según versión puede venir store_id o user_id; guardamos lo que exista
    const access_token = data.access_token;
    const sid = String(data.store_id || data.user_id || "").trim();

    if (!access_token) {
      console.error("Token response sin access_token:", data);
      return res.status(400).send("No se recibió token");
    }

    // Si no vino store_id, no frenamos: mostramos admin mínimo sin ID
    if (!sid) {
      console.warn("No se recibió store_id/user_id en token. Redirigiendo a /admin genérico.");
      return res.redirect(`/admin`);
    }

    stores.set(sid, { access_token });
    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    return res.status(500).send("Error en OAuth");
  }
});

// ----------------------------------------------------------------------------
// 3) Admin mínimo (placeholder)
// ----------------------------------------------------------------------------
app.get("/admin", (req, res) => {
  const { store_id } = req.query;
  const hasStore = store_id && stores.has(String(store_id));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px;max-width:960px;margin:auto">
  <h1>App instalada ${store_id ? `para la tienda: <code>${store_id}</code>` : ""}</h1>
  <p>${hasStore ? "Token guardado en memoria ✔️" : "Sin token o store_id. Instalá desde <code>/install?store_id=TU_TIENDA</code>"} </p>
  <hr/>
  <p>Panel mínimo. Próximo paso: UI de campañas, conexión a Postgres y Discount API.</p>
</body></html>`);
});

// ----------------------------------------------------------------------------
// 4) Endpoints base para integrar con Tiendanube (placeholders seguros)
// ----------------------------------------------------------------------------
app.post("/discounts/callback", (_req, res) => {
  // Por ahora, no aplicamos descuentos hasta finalizar la lógica
  return res.json({ discounts: [] });
});

app.post("/webhooks/orders/create", (_req, res) => {
  // ACK inmediato de webhook
  return res.sendStatus(200);
});

// ----------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
