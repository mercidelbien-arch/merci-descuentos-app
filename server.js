// server.js — ESM limpio, Express + APIs Merci
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieSession from 'cookie-session';
import axios from 'axios';
import crypto from 'crypto';

import templatesRouter from './api/routes/templates.js';
import { pool } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- Constantes ---
const PROMO_ID = process.env.TN_PROMO_ID || '1c508de3-84a0-4414-9c75-c2aee4814fcd';

// --- App ---
const app = express();
app.set('trust proxy', 1);

// --- Middlewares (orden correcto) ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SESSION_SECRET || 'dev',
  httpOnly: true,
  sameSite: 'lax',
}));

// OJO: NO servimos todo / desde admin/dist para evitar conflictos.
// Solo servimos /admin más abajo con fallback SPA.

// -------------------- Rutas básicas --------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, node: process.version, ts: Date.now() });
});

// Router de plantillas (si lo usás)
app.use('/api/templates', templatesRouter);

// Widget estático (solo /widget)
app.use('/widget', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// -------------------- DB / Utilidades --------------------
app.get('/api/db/ping', async (_req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/debug/stores', async (_req, res) => {
  try {
    const r = await pool.query('SELECT store_id, created_at FROM stores ORDER BY created_at DESC LIMIT 5');
    res.json({ ok: true, stores: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

    -- modelo viejo (mantengo para compatibilidad)
    type TEXT NOT NULL CHECK (type IN ('percentage','absolute')),
    value INTEGER NOT NULL,

    -- modelo nuevo (el que usa el motor/callback)
    discount_type TEXT,          -- 'percent' | 'absolute'
    discount_value NUMERIC,

    valid_from DATE,
    valid_until DATE,
    apply_scope TEXT DEFAULT 'all',
    min_cart_amount NUMERIC DEFAULT 0,
    max_discount_amount NUMERIC,
    monthly_cap_amount NUMERIC,
    exclude_sale_items BOOLEAN DEFAULT false,

    -- campos legacy (no usados por el motor, pero preservo)
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
app.get('/api/db/migrate', async (_req, res) => {
  try {
    await pool.query(MIGRATE_SQL);
    res.json({ ok: true, message: 'Migraciones aplicadas' });
  } catch (e) {
    console.error('MIGRATE error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- Redirección Home -> Admin --------------------
app.get('/', (_req, res) => {
  // Ajustá este store_id si querés uno por defecto distinto
  res.redirect('/admin/?store_id=3739596');
});

// -------------------- OAuth Tienda Nube --------------------
app.get('/install', (req, res) => {
  const appId = process.env.TN_CLIENT_ID;
  if (!appId) return res.status(500).send('Falta TN_CLIENT_ID');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  const url = `https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Callback inválido');
    if (req.session?.state && state !== req.session.state) return res.status(400).send('Estado inválido');

    const redirect_uri = `${process.env.APP_BASE_URL}/oauth/callback`;
    const form = new URLSearchParams();
    form.append('client_id', process.env.TN_CLIENT_ID);
    form.append('client_secret', process.env.TN_CLIENT_SECRET);
    form.append('code', String(code));
    form.append('grant_type', 'authorization_code');
    form.append('redirect_uri', redirect_uri);

    const tokenRes = await axios.post(
      'https://www.tiendanube.com/apps/authorize/token',
      form.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const data = tokenRes.data || {};
    const access_token = data.access_token;
    const sid = String(data.store_id || data.user_id || '').trim();
    if (!access_token) return res.status(400).send('No se recibió token');

    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (store_id) DO UPDATE
       SET access_token = EXCLUDED.access_token, updated_at = now()`,
      [sid, access_token]
    );

    return res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error('OAuth callback error:', e.response?.data || e.message);
    return res.status(500).send('Error en OAuth');
  }
});

// -------------------- Tienda Nube helpers --------------------
function tnBase(store_id) { return `https://api.tiendanube.com/v1/${store_id}`; }
function tnHeaders(token) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    // TN usa 'Authentication' (no Authorization)
    'Authentication': `bearer ${token}`,
    'User-Agent': 'Merci Descuentos (andres.barba82@gmail.com)',
  };
}

// TN: categorías
app.get('/api/tn/categories', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ message: 'Falta store_id' });

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: 'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    const resp = await axios.get(`${tnBase(store_id)}/categories`, {
      headers: tnHeaders(token), params: { per_page: 250 },
    });

    const cats = (resp.data || []).map(c => ({
      id: c.id, name: c.name?.es || c.name?.pt || c.name?.en || String(c.id),
    }));
    return res.json(cats);
  } catch (e) {
    console.error('GET /api/tn/categories error:', e.response?.data || e.message);
    return res.status(e.response?.status || 500).json({ message: 'Error obteniendo categorías', detail: e.response?.data || e.message });
  }
});

// Registrar callback del motor de descuentos en TN
app.all('/api/tn/register-callback', async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ message: 'Falta store_id' });

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: 'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    const callbackUrl = `${process.env.APP_BASE_URL}/discounts/callback`;
    const resp = await axios.put(`${tnBase(store_id)}/discounts/callbacks`, { url: callbackUrl }, { headers: tnHeaders(token), timeout: 8000 });
    return res.json({ ok: true, data: resp.data || null, url: callbackUrl });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.get('/api/tn/promotions/register-base', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    const body = { name: 'Merci Engine – Base', allocation_type: 'cross_items' };
    const resp = await axios.post(`${tnBase(store_id)}/promotions`, body, { headers: tnHeaders(token) });
    return res.json({ ok:true, data: resp.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

// Listar/instalar scripts TN
app.get('/api/tn/scripts/list', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    const listRes = await axios.get(`${tnBase(store_id)}/scripts`, { headers: tnHeaders(token) });
    return res.json({ ok:true, raw:listRes.data });
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.all('/api/tn/scripts/install/by-id', async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || '').trim();
    const script_id = String((req.body?.script_id) || req.query.script_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });
    if (!script_id) return res.status(400).json({ ok:false, error:'Falta script_id' });

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    try {
      const upd = await axios.put(`${tnBase(store_id)}/scripts/${script_id}`, { script_id, enabled: true }, { headers: tnHeaders(token) });
      return res.json({ ok:true, action:'updated_by_id', data: upd.data });
    } catch (e1) {
      const created = await axios.post(`${tnBase(store_id)}/scripts`, { script_id, enabled: true }, { headers: tnHeaders(token) });
      return res.json({ ok:true, action:'created_by_id', data: created.data });
    }
  } catch (e) {
    return res.status(e.response?.status || 500).json({ ok:false, error: e.response?.data || e.message });
  }
});

app.all('/api/tn/scripts/install/direct', async (req, res) => {
  try {
    const store_id = String(req.body?.store_id || req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });

    const src = String(req.body?.src || req.query.src || `${process.env.APP_BASE_URL}/widget/merci-checkout-coupon-widget.js`).trim();
    const name = String(req.body?.name || req.query.name || 'Merci Checkout Widget (direct)').trim();
    const event = String(req.body?.event || req.query.event || 'onload').trim();
    const location = String(req.body?.location || req.query.location || 'checkout').trim();

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    const body = { name, src, event, location, enabled: true };
    const created = await axios.post(`${tnBase(store_id)}/scripts`, body, { headers: tnHeaders(token) });
    return res.json({ ok:true, action:'created_direct', data: created.data });
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

app.get('/api/metrics/summary', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
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
    console.error('GET /api/metrics/summary error:', e);
    res.status(500).json({ ok:false, error: msg });
  }
});

app.get('/api/metrics/series/daily', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
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
    console.error('GET /api/metrics/series/daily error:', e);
    res.status(500).json({ ok:false, error: msg });
  }
});

// -------------------- API campañas --------------------
app.get('/api/campaigns', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
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
    console.error('GET /api/campaigns error:', err);
    res.status(500).json({ message: 'Error al obtener campañas' });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const b = req.body || {};
    const store_id = String(b.store_id || '').trim();
    const code = String(b.code || '').trim();
    const name = String(b.name || '').trim();
    if (!store_id || !code || !name) return res.status(400).json({ message: 'Faltan store_id, code o name' });

    const discount_type = (b.discount_type || 'percent').toLowerCase(); // 'percent' | 'absolute'
    const discount_value_num = Number(b.discount_value ?? 0);
    const type = discount_type === 'percent' ? 'percentage' : 'absolute';
    const value = Number.isFinite(discount_value_num) ? Math.round(discount_value_num) : 0;

    const valid_from = b.valid_from || new Date().toISOString().slice(0,10);
    const valid_until = b.valid_until || new Date().toISOString().slice(0,10);
    const apply_scope = (b.apply_scope || 'all').toString();

    const min_cart_amount   = b.min_cart_amount   !== undefined ? Number(b.min_cart_amount)   : 0;
    const max_discount_amount = b.max_discount_amount !== undefined ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount = b.monthly_cap_amount !== undefined ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true;

    const toJsonb = (arr) => (Array.isArray(arr) && arr.length ? JSON.stringify(arr.map(Number)) : null);
    const include_category_ids = toJsonb(b.include_category_ids);
    const exclude_category_ids = toJsonb(b.exclude_category_ids);
    const include_product_ids  = toJsonb(b.include_product_ids);
    const exclude_product_ids  = toJsonb(b.exclude_product_ids);

    // legacy (no usado por motor, pero lo llenamos coherente)
    const min_cart     = b.min_cart     != null ? Number(b.min_cart)     : 0;
    const monthly_cap  = b.monthly_cap  != null ? Number(b.monthly_cap)  : 0;
    const exclude_on_sale = b.exclude_on_sale != null ? !!b.exclude_on_sale : false;

    const status = 'active';

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
      exclude_on_sale, status,
      discount_type, discount_value_num,
      valid_from, valid_until, apply_scope,
      min_cart_amount, max_discount_amount, monthly_cap_amount,
      exclude_sale_items,
      include_category_ids, exclude_category_ids,
      include_product_ids, exclude_product_ids
    ];
    const r = await pool.query(sql, params);
    return res.json({ ok: true, campaign: r.rows[0] });
  } catch (e) {
    console.error('POST /api/campaigns error:', e);
    return res.status(500).json({ message: 'Error al crear campaña', detail: e.detail || e.message });
  }
});

// Cambiar estado (toggle) active <-> paused
app.post('/api/campaigns/:id/toggle-status', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });

    const { rows } = await pool.query(`SELECT status FROM campaigns WHERE id=$1 LIMIT 1`, [id]);
    if (rows.length === 0) return res.status(404).json({ ok:false, error:'No existe campaña' });

    const curr = (rows[0].status || '').toLowerCase();
    const next = curr === 'active' ? 'paused' : 'active';

    const upd = await pool.query(
      `UPDATE campaigns SET status=$1, updated_at=now() WHERE id=$2 RETURNING id, code, name, status`,
      [next, id]
    );

    return res.json({ ok:true, campaign: upd.rows[0] });
  } catch (e) {
    console.error('POST /api/campaigns/:id/toggle-status error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// Eliminar campaña
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });

    const del = await pool.query(`DELETE FROM campaigns WHERE id=$1`, [id]);
    if (del.rowCount === 0) return res.status(404).json({ ok:false, error:'No existe campaña' });

    return res.json({ ok:true, deleted: id });
  } catch (e) {
    console.error('DELETE /api/campaigns/:id error:', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// -------------------- Discounts Callback (motor) --------------------
app.post('/discounts/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const store_id = String(body.store_id || '').trim();
    const currency = body.currency || 'ARS';
    if (!store_id) {
      return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
    }

    const tryStr = (v) => (typeof v === 'string' ? v.trim() : '');
    const scanArray = (arr) => {
      if (!Array.isArray(arr)) return '';
      for (const it of arr) {
        const k = tryStr(it?.name || it?.key).toLowerCase();
        const v = tryStr(it?.value);
        if (!k || !v) continue;
        if (/(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(k)) return v;
      }
      return '';
    };
    const scanObject = (obj) => {
      if (!obj || typeof obj !== 'object') return '';
      for (const [k, v] of Object.entries(obj)) {
        const kk = tryStr(k).toLowerCase(); const vv = tryStr(v);
        if (!kk || !vv) continue;
        if (/(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(kk)) return vv;
      }
      return '';
    };
    const getCodeFromPayload = (b) =>
      tryStr(b.code) || scanArray(b.custom_fields) || scanArray(b.additional_fields) ||
      scanArray(b.note_attributes) || scanArray(b?.checkout?.custom_fields) ||
      scanArray(b?.checkout?.attributes) || scanObject(b.attributes) ||
      scanObject(b.checkout?.attributes) || '';

    let code = getCodeFromPayload(body).toUpperCase();

    const checkout_id = String(body.checkout_id || body.checkout_token || (body.checkout && body.checkout.id) || body.token || '').trim();
    if (!code && checkout_id) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS checkout_codes (
          checkout_id TEXT PRIMARY KEY,
          code        TEXT NOT NULL,
          created_at  TIMESTAMPTZ DEFAULT now()
        )`);
      const r = await pool.query(`SELECT code FROM checkout_codes WHERE checkout_id = $1 LIMIT 1`, [checkout_id]);
      if (r.rowCount > 0) code = String(r.rows[0].code || '').trim().toUpperCase();
    }
    if (!code) return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });

    const q = await pool.query(
      `SELECT * FROM campaigns WHERE store_id = $1 AND UPPER(code) = $2 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [store_id, code]
    );
    if (q.rowCount === 0) return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
    const c = q.rows[0];

    const today = new Date().toISOString().slice(0,10);
    if ((c.valid_from && today < c.valid_from) || (c.valid_until && today > c.valid_until)) {
      return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
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
      if (String(c.apply_scope || 'all') === 'categories') {
        const cats = getCatIds(p);
        const matchesInc = inc.length === 0 ? true : cats.some(id => inc.includes(id));
        const matchesExc = exc.length > 0   ? cats.some(id => exc.includes(id)) : false;
        ok = matchesInc && !matchesExc;
      }
      if (ok) eligibleSubtotal += price * qty;
    }
    if (eligibleSubtotal <= 0) return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });

    if (c.min_cart_amount && eligibleSubtotal < Number(c.min_cart_amount)) {
      return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
    }

    const dtype = String(c.discount_type || 'percent').toLowerCase();
    const dval  = Number(c.discount_value || 0);
    let amount  = (dtype === 'percent') ? (eligibleSubtotal * dval / 100) : dval;
    if (c.max_discount_amount != null) amount = Math.min(amount, Number(c.max_discount_amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
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
      `SELECT COALESCE(SUM(applied_amount),0) AS used FROM coupon_ledger WHERE store_id = $1 AND CODE = $2`,
      [store_id, code]
    );
    const used = Number(sumRows[0]?.used || 0);
    const cap = (c.cap_total_amount != null ? Number(c.cap_total_amount)
           : (c.monthly_cap_amount != null ? Number(c.monthly_cap_amount) : null));

    let cappedAmount = amount;
    if (cap != null && cap >= 0) {
      const remaining = Math.max(0, cap - used);
      if (remaining <= 0) {
        return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
      }
      cappedAmount = Math.min(amount, remaining);
    }

    const checkout_id2 = String(body.checkout_id || body.checkout_token || body.token || '').trim();
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
        command: 'create_or_update_discount',
        specs: {
          promotion_id: PROMO_ID,
          currency,
          display_text: { 'es-ar': label },
          discount_specs: { type: 'fixed', amount: cappedAmount.toFixed(2) }
        }
      }]
    });
  } catch (e) {
    console.error('discounts/callback error:', e);
    return res.json({ commands: [{ command: 'delete_discount', specs: { promotion_id: PROMO_ID } }] });
  }
});

// Webhook “no-op” (placeholder)
app.post('/webhooks/orders/create', (_req, res) => res.sendStatus(200));

// ===== Admin (React build) =====
app.use('/admin', express.static(path.join(__dirname, 'admin/dist'), { maxAge: '1h' }));

// Fallback SPA para rutas de React Router (p.ej. /admin/campaigns)
app.get('/admin/*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin/dist/index.html'));
});

// -------------------- Start --------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log('Server on :' + PORT));
