// server.js — MVP mínimo para que /install funcione y puedas autorizar la app
// Luego iteramos con Discount API y DB.

import express from 'express';
import dotenv from 'dotenv';
import cookieSession from 'cookie-session';
import axios from 'axios';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cookieSession({
    name: 'sess',
    secret: process.env.SESSION_SECRET || 'dev',
    httpOnly: true,
  })
);

const { TN_CLIENT_ID, TN_CLIENT_SECRET, APP_BASE_URL } = process.env;

// Memoria simple sólo para probar OAuth rápidamente
const stores = new Map(); // store_id -> { access_token }

// Salud
app.get('/', (req, res) => {
  res.send('OK');
});

// 1) Instalación / OAuth — TIENDANUBE
app.get('/install', (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) return res.status(400).send('Falta store_id');
    if (!TN_CLIENT_ID || !TN_CLIENT_SECRET || !APP_BASE_URL) {
      return res
        .status(500)
        .send('Faltan variables de entorno (TN_CLIENT_ID, TN_CLIENT_SECRET, APP_BASE_URL)');
    }

    const redirect_uri = `${APP_BASE_URL}/oauth/callback`;
    const state = crypto.randomBytes(12).toString('hex');
    req.session.state = state;

    const authUrl = `https://www.tiendanube.com/apps/${TN_CLIENT_ID}/authorize?response_type=code&client_id=${TN_CLIENT_ID}&redirect_uri=${encodeURIComponent(
      redirect_uri
    )}&state=${state}&scope=read_products,write_discounts,read_orders`;

    return res.redirect(authUrl);
  } catch (e) {
    console.error('Install error:', e);
    return res.status(500).send('Error en /install');
  }
});

// 2) Callback OAuth — canjea code por access_token y guarda en memoria
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, store_id } = req.query;
    if (!code || !state) return res.status(400).send('Callback inválido');
    if (state !== req.session.state) return res.status(400).send('Estado inválido');

    const tokenRes = await axios.post('https://www.tiendanube.com/apps/authorize/token', {
      client_id: TN_CLIENT_ID,
      client_secret: TN_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const { access_token, store_id: sid } = tokenRes.data || {};
    if (!access_token || !sid) return res.status(400).send('No se recibió token');

    stores.set(String(sid), { access_token });
    // Redirigimos a una pantalla simple dentro del Admin embebido
    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error('OAuth callback error:', e.response?.data || e.message);
    return res.status(500).send('Error en OAuth');
  }
});

// 3) Admin mínimo (luego lo reemplazamos por la UI completa)
app.get('/admin', (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).send('Falta store_id');
  const hasStore = stores.has(String(store_id));
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Cupones Merci</title></head>
<body style="font-family:system-ui;padding:24px">
  <h1>App instalada para la tienda: ${store_id}</h1>
  <p>${hasStore ? 'Token guardado en memoria ✔️' : 'Sin token (instalá desde /install)'} </p>
  <p>Este es un panel mínimo. Próximo paso: UI completa y conexión a Postgres.</p>
</body></html>`);
});

// 4) Endpoints de integración (placeholders seguros por ahora)
app.post('/discounts/callback', (req, res) => {
  // Devolvemos sin descuentos hasta terminar la lógica
  return res.json({ discounts: [] });
});

app.post('/webhooks/orders/create', (req, res) => {
  // ACK inmediato
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
