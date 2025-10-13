// server.js — Express ESM limpio
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieSession from 'cookie-session';
import axios from 'axios';
import crypto from 'crypto';

import templatesRouter from './api/routes/templates.js';
import { pool } from './db.js'; // ✅ usamos el pool que ya viene de db.js

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMO_ID = process.env.TN_PROMO_ID || '1c508de3-84a0-4414-9c75-c2aee4814fcd';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SESSION_SECRET || 'dev',
  httpOnly: true,
  sameSite: 'lax',
}));

/* ---------- Básicas ---------- */
app.get('/api/health', (_req, res) => res.json({ ok:true, node:process.version, ts:Date.now() }));
app.use('/api/templates', templatesRouter);
app.use('/widget', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/* ---------- DB / Migraciones ---------- */
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

    -- viejo
    type TEXT NOT NULL CHECK (type IN ('percentage','absolute')),
    value INTEGER NOT NULL,

    -- nuevo
    discount_type TEXT,
    discount_value NUMERIC,

    valid_from DATE,
    valid_until DATE,
    apply_scope TEXT DEFAULT 'all',
    min_cart_amount NUMERIC DEFAULT 0,
    max_discount_amount NUMERIC,
    monthly_cap_amount NUMERIC,
    exclude_sale_items BOOLEAN DEFAULT false,

    -- legacy
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
  try { await pool.query(MIGRATE_SQL); res.json({ ok:true, message:'Migraciones aplicadas' }); }
  catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/', (_req, res) => {
  res.redirect('/admin/?store_id=3739596');
});


/* ---------- OAuth Tienda Nube ---------- */
app.get('/install', (req, res) => {
  const appId = process.env.TN_CLIENT_ID;
  if (!appId) return res.status(500).send('Falta TN_CLIENT_ID');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  res.redirect(`https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`);
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

    const tokenRes = await axios.post('https://www.tiendanube.com/apps/authorize/token', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const access_token = tokenRes.data?.access_token;
    const sid = String(tokenRes.data?.store_id || tokenRes.data?.user_id || '').trim();
    if (!access_token) return res.status(400).send('No se recibió token');

    await pool.query(
      `INSERT INTO stores (store_id, access_token)
       VALUES ($1,$2)
       ON CONFLICT (store_id) DO UPDATE SET access_token=EXCLUDED.access_token, updated_at=now()`,
      [sid, access_token]
    );
    res.redirect(`/admin?store_id=${sid}`);
  } catch (e) {
    console.error('OAuth error:', e.response?.data || e.message);
    res.status(500).send('Error en OAuth');
  }
});

/* ---------- TN helpers ---------- */
const tnBase = (store_id) => `https://api.tiendanube.com/v1/${store_id}`;
const tnHeaders = (token) => ({
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Authentication': `bearer ${token}`,
  'User-Agent': 'Merci Descuentos (andres.barba82@gmail.com)',
});

app.get('/api/tn/categories', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ message:'Falta store_id' });
    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message:'No hay token' });
    const resp = await axios.get(`${tnBase(store_id)}/categories`, { headers: tnHeaders(r.rows[0].access_token), params:{ per_page:250 }});
    const cats = (resp.data||[]).map(c=>({ id:c.id, name:c.name?.es || c.name?.pt || c.name?.en || String(c.id) }));
    res.json(cats);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ message:'Error obteniendo categorías', detail:e.response?.data || e.message });
  }
});

// Buscar productos por texto (nombre / SKU)
app.get('/api/tn/products/search', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    const q = String(req.query.q || '').trim();
    if (!store_id) return res.status(400).json({ message: 'Falta store_id' });
    if (q.length < 2) return res.json([]);

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: 'No hay token para esa tienda' });
    const token = r.rows[0].access_token;

    // Tiendanube: /products?per_page=30&q=texto  (filtra por nombre/sku)
    const resp = await axios.get(`${tnBase(store_id)}/products`, {
      headers: tnHeaders(token),
      params: { per_page: 30, q },
    });

    const out = (resp.data || []).map(p => ({
      id: p.id,
      name: p.name?.es || p.name?.pt || p.name?.en || `#${p.id}`,
    }));
    res.json(out);
  } catch (e) {
    console.error('GET /api/tn/products/search error:', e.response?.data || e.message);
    res.status(e.response?.status || 500).json({ message: 'Error buscando productos' });
  }
});

// Obtener un cupón por ID
app.get("/api/campaigns/:id", async (req, res) => {
  const { id } = req.params;
  const { store_id } = req.query;

  try {
    const result = await pool.query(
      `SELECT * FROM campaigns WHERE id = $1 ${store_id ? "AND store_id = $2" : ""} LIMIT 1`,
      store_id ? [id, store_id] : [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cupón no encontrado" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error al obtener cupón:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});



app.all('/api/tn/register-callback', async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ message:'Falta store_id' });
    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message:'No hay token' });
    const url = `${process.env.APP_BASE_URL}/discounts/callback`;
    const resp = await axios.put(`${tnBase(store_id)}/discounts/callbacks`, { url }, { headers: tnHeaders(r.rows[0].access_token), timeout:8000 });
    res.json({ ok:true, data:resp.data || null, url });
  } catch (e) { res.status(e.response?.status || 500).json({ ok:false, error:e.response?.data || e.message }); }
});

app.get('/api/tn/promotions/register-base', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });
    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token' });
    const body = { name:'Merci Engine – Base', allocation_type:'cross_items' };
    const resp = await axios.post(`${tnBase(store_id)}/promotions`, body, { headers: tnHeaders(r.rows[0].access_token) });
    res.json({ ok:true, data:resp.data });
  } catch (e) { res.status(e.response?.status || 500).json({ ok:false, error:e.response?.data || e.message }); }
});

app.get('/api/tn/scripts/list', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });
    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token' });
    const listRes = await axios.get(`${tnBase(store_id)}/scripts`, { headers: tnHeaders(r.rows[0].access_token) });
    res.json({ ok:true, raw:listRes.data });
  } catch (e) { res.status(e.response?.status || 500).json({ ok:false, error:e.response?.data || e.message }); }
});

app.all('/api/tn/scripts/install/by-id', async (req, res) => {
  try {
    const store_id = String((req.body?.store_id) || req.query.store_id || '').trim();
    const script_id = String((req.body?.script_id) || req.query.script_id || '').trim();
    if (!store_id) return res.status(400).json({ ok:false, error:'Falta store_id' });
    if (!script_id) return res.status(400).json({ ok:false, error:'Falta script_id' });
    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token' });
    try {
      const upd = await axios.put(`${tnBase(store_id)}/scripts/${script_id}`, { script_id, enabled:true }, { headers: tnHeaders(r.rows[0].access_token) });
      res.json({ ok:true, action:'updated_by_id', data:upd.data });
    } catch {
      const created = await axios.post(`${tnBase(store_id)}/scripts`, { script_id, enabled:true }, { headers: tnHeaders(r.rows[0].access_token) });
      res.json({ ok:true, action:'created_by_id', data:created.data });
    }
  } catch (e) { res.status(e.response?.status || 500).json({ ok:false, error:e.response?.data || e.message }); }
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
    if (r.rowCount === 0) return res.status(401).json({ ok:false, error:'No hay token' });
    const body = { name, src, event, location, enabled:true };
    const created = await axios.post(`${tnBase(store_id)}/scripts`, body, { headers: tnHeaders(r.rows[0].access_token) });
    res.json({ ok:true, action:'created_direct', data:created.data });
  } catch (e) { res.status(e.response?.status || 500).json({ ok:false, error:e.response?.data || e.message }); }
});

/* ---------- Métricas (home) ---------- */
const monthRange = (offset=0) => {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+offset, 1));
  const to   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth()+offset+1, 1));
  return { from:from.toISOString(), to:to.toISOString() };
};
const pctChange = (curr, prev) => (!prev ? (curr>0?100:0) : Math.round(((curr-prev)/prev)*100));

app.get('/api/metrics/summary', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    const { from:mFrom, to:mTo } = monthRange(0);
    const { from:pFrom, to:pTo } = monthRange(-1);
    const [{ rows:r1 }, { rows:r2 }, { rows:r3 }] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(applied_amount),0)::numeric AS total FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`, [store_id, mFrom, mTo]),
      pool.query(`SELECT COUNT(DISTINCT COALESCE(order_id, checkout_id))::int AS orders FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`, [store_id, mFrom, mTo]),
      pool.query(`SELECT COUNT(DISTINCT customer_id)::int AS customers FROM coupon_ledger WHERE store_id=$1 AND customer_id IS NOT NULL AND created_at >= $2 AND created_at < $3`, [store_id, mFrom, mTo]),
    ]);
    const month_total = Number(r1[0]?.total||0);
    const month_orders = Number(r2[0]?.orders||0);
    const month_customers = Number(r3[0]?.customers||0);

    const [{ rows:pr1 }, { rows:pr2 }, { rows:pr3 }] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(applied_amount),0)::numeric AS total FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`, [store_id, pFrom, pTo]),
      pool.query(`SELECT COUNT(DISTINCT COALESCE(order_id, checkout_id))::int AS orders FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3`, [store_id, pFrom, pTo]),
      pool.query(`SELECT COUNT(DISTINCT customer_id)::int AS customers FROM coupon_ledger WHERE store_id=$1 AND customer_id IS NOT NULL AND created_at >= $2 AND created_at < $3`, [store_id, pFrom, pTo]),
    ]);
    const prev_total = Number(pr1[0]?.total||0);
    const prev_orders = Number(pr2[0]?.orders||0);
    const prev_customers = Number(pr3[0]?.customers||0);

    const { rows:topRows } = await pool.query(`
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
        LEFT JOIN campaigns c ON c.store_id=$1 AND UPPER(c.code)=m.code AND c.status='active'
       ORDER BY m.amt DESC NULLS LAST
       LIMIT 1
    `, [store_id, mFrom, mTo]);

    res.json({
      ok:true,
      month:{
        total_discount: month_total,
        orders_with_coupon: month_orders,
        customers: month_customers,
        change_vs_prev:{
          total_discount_pct: pctChange(month_total, prev_total),
          orders_with_coupon_pct: pctChange(month_orders, prev_orders),
          customers_pct: pctChange(month_customers, prev_customers),
        },
        top_campaign: topRows[0] || null
      }
    });
  } catch (e) {
    const msg = String(e.message||e);
    if (/relation .*coupon_ledger.* does not exist/i.test(msg)) {
      return res.json({ ok:true, month:{ total_discount:0, orders_with_coupon:0, customers:0, change_vs_prev:{ total_discount_pct:0, orders_with_coupon_pct:0, customers_pct:0 }, top_campaign:null }});
    }
    console.error(e); res.status(500).json({ ok:false, error:msg });
  }
});

app.get('/api/metrics/series/daily', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    const { from:mFrom, to:mTo } = monthRange(0);
    const [{ rows:uses }, { rows:amounts }] = await Promise.all([
      pool.query(`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS uses FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`, [store_id, mFrom, mTo]),
      pool.query(`SELECT date_trunc('day', created_at)::date AS day, COALESCE(SUM(applied_amount),0)::numeric AS amount FROM coupon_ledger WHERE store_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY 1`, [store_id, mFrom, mTo]),
    ]);
    res.json({ ok:true, uses_per_day:uses, amount_per_day:amounts });
  } catch (e) {
    const msg = String(e.message||e);
    if (/relation .*coupon_ledger.* does not exist/i.test(msg)) return res.json({ ok:true, uses_per_day:[], amount_per_day:[] });
    console.error(e); res.status(500).json({ ok:false, error:msg });
  }
});

/* ---------- Campañas CRUD ---------- */
// LISTAR (oculta status='deleted' si los hubiera)
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
              exclude_sale_items, created_at, updated_at
         FROM campaigns
        WHERE store_id=$1 AND status <> 'deleted'
        ORDER BY created_at DESC`,
      [store_id]
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ message:'Error al obtener campañas' }); }
});

// --- CREAR CUPÓN (mock) ---
app.post('/api/campaigns', async (req, res) => {
  try {
    const {
      store_id,
      code,
      name,
      discount_type,
      discount_value,
      valid_from,
      valid_until,
      apply_scope,
      include_category_ids = [],
      exclude_category_ids = [],
      include_product_ids = [],
      exclude_product_ids = [],
      max_discount_amount = null,
      min_cart_amount = null,
    } = req.body || {};

    if (!store_id) return res.status(400).json({ error: 'Falta store_id' });
    if (!code) return res.status(400).json({ error: 'Falta code' });

    // TODO: guardar en DB y devolver el registro real
    const now = new Date().toISOString();
    const mock = {
      id: String(Math.floor(Math.random() * 1000000)),
      store_id,
      code,
      name: name || code,
      discount_type: discount_type || 'percent',
      discount_value: Number(discount_value ?? 0),
      valid_from: valid_from || null,
      valid_until: valid_until || null,
      apply_scope: apply_scope || 'all',
      include_category_ids,
      exclude_category_ids,
      include_product_ids,
      exclude_product_ids,
      max_discount_amount,
      min_cart_amount,
      status: 'active',
      created_at: now,
      updated_at: now,
    };

    return res.status(201).json(mock);
  } catch (e) {
    console.error('POST /api/campaigns error:', e);
    res.status(500).json({ error: 'Error creando cupón' });
  }
});

// --- ACTUALIZAR CUPÓN (mock) ---
app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      store_id,
      code,
      name,
      discount_type,
      discount_value,
      valid_from,
      valid_until,
      apply_scope,
      include_category_ids = [],
      exclude_category_ids = [],
      include_product_ids = [],
      exclude_product_ids = [],
      max_discount_amount = null,
      min_cart_amount = null,
    } = req.body || {};

    if (!store_id) return res.status(400).json({ error: 'Falta store_id' });
    if (!id) return res.status(400).json({ error: 'Falta id' });

    // TODO: update real en DB y devolver registro actualizado
    const now = new Date().toISOString();
    const mock = {
      id,
      store_id,
      code,
      name: name || code,
      discount_type: discount_type || 'percent',
      discount_value: Number(discount_value ?? 0),
      valid_from: valid_from || null,
      valid_until: valid_until || null,
      apply_scope: apply_scope || 'all',
      include_category_ids,
      exclude_category_ids,
      include_product_ids,
      exclude_product_ids,
      max_discount_amount,
      min_cart_amount,
      status: 'active',
      updated_at: now,
    };

    return res.status(200).json(mock);
  } catch (e) {
    console.error('PUT /api/campaigns/:id error:', e);
    res.status(500).json({ error: 'Error actualizando cupón' });
  }
});

// CAMBIAR ESTADO (active|paused)
app.patch('/api/campaigns/:id/status', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const next = String(req.body?.status || '').trim().toLowerCase();
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });
    if (!['active','paused'].includes(next)) return res.status(400).json({ ok:false, error:'Estado inválido (use active|paused)' });
    const r = await pool.query(
      `UPDATE campaigns SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, code, status`,
      [id, next]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok:false, error:'No existe la campaña' });
    res.json({ ok:true, campaign:r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

// ELIMINAR (real)
app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });
    const del = await pool.query(`DELETE FROM campaigns WHERE id=$1`, [id]);
    if (del.rowCount === 0) return res.status(404).json({ ok:false, error:'No existe campaña' });
    res.json({ ok:true, deleted:id });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

/* ---------- Motor de descuentos (callback) ---------- */
app.post('/discounts/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const store_id = String(body.store_id || '').trim();
    const currency = body.currency || 'ARS';
    if (!store_id) return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });

    const tryStr = (v)=> (typeof v === 'string' ? v.trim() : '');
    const scanArray = (arr)=> Array.isArray(arr) ? (arr.find(it=>{
      const k = tryStr(it?.name || it?.key).toLowerCase(); const v = tryStr(it?.value);
      return k && v && /(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(k);
    })?.value||'') : '';
    const scanObject = (obj)=> obj && typeof obj==='object' ? (Object.entries(obj).find(([k,v])=>{
      const kk=tryStr(k).toLowerCase(); const vv=tryStr(v);
      return kk && vv && /(c(o|ó)digo.*(cup(o|ó)n|convenio)|coupon|promo|codigo|código)/.test(kk);
    })?.[1] || '') : '';
    const getCode = (b)=> tryStr(b.code) || scanArray(b.custom_fields) || scanArray(b.additional_fields) ||
      scanArray(b.note_attributes) || scanArray(b?.checkout?.custom_fields) ||
      scanArray(b?.checkout?.attributes) || scanObject(b.attributes) || scanObject(b.checkout?.attributes) || '';
    let code = getCode(body).toUpperCase();

    const checkout_id = String(body.checkout_id || body.checkout_token || body.checkout?.id || body.token || '').trim();
    if (!code && checkout_id) {
      await pool.query(`CREATE TABLE IF NOT EXISTS checkout_codes (checkout_id TEXT PRIMARY KEY, code TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
      const r = await pool.query(`SELECT code FROM checkout_codes WHERE checkout_id=$1 LIMIT 1`, [checkout_id]);
      if (r.rowCount>0) code = String(r.rows[0].code||'').trim().toUpperCase();
    }
    if (!code) return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });

    const q = await pool.query(`SELECT * FROM campaigns WHERE store_id=$1 AND UPPER(code)=$2 AND status='active' ORDER BY created_at DESC LIMIT 1`, [store_id, code]);
    if (q.rowCount===0) return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
    const c = q.rows[0];

    const today = new Date().toISOString().slice(0,10);
    if ((c.valid_from && today < c.valid_from) || (c.valid_until && today > c.valid_until)) {
      return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
    }

    const products = Array.isArray(body.products) ? body.products : [];
    const parseJsonb = (v)=>{ if (Array.isArray(v)) return v; if (!v) return []; try { return JSON.parse(v); } catch { return []; } };
    const inc = parseJsonb(c.include_category_ids).map(Number);
    const exc = parseJsonb(c.exclude_category_ids).map(Number);
    const getCatIds = (p)=> Array.isArray(p.category_ids) ? p.category_ids.map(Number)
      : Array.isArray(p.categories) ? p.categories.flatMap(cat=>[cat.id, ...(Array.isArray(cat.subcategories)?cat.subcategories:[])]).map(Number)
      : [];
    let eligibleSubtotal = 0;
    for (const p of products) {
      const price = Number(p.price||0), qty = Number(p.quantity||0);
      let ok = true;
      if (String(c.apply_scope||'all')==='categories') {
        const cats = getCatIds(p);
        const matchesInc = inc.length===0 ? true : cats.some(id=>inc.includes(id));
        const matchesExc = exc.length>0 ? cats.some(id=>exc.includes(id)) : false;
        ok = matchesInc && !matchesExc;
      }
      if (ok) eligibleSubtotal += price*qty;
    }
    if (eligibleSubtotal<=0) return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });

    if (c.min_cart_amount && eligibleSubtotal < Number(c.min_cart_amount)) {
      return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
    }

    const dtype = String(c.discount_type || 'percent').toLowerCase();
    const dval  = Number(c.discount_value || 0);
    let amount  = (dtype==='percent') ? (eligibleSubtotal*dval/100) : dval;
    if (c.max_discount_amount!=null) amount = Math.min(amount, Number(c.max_discount_amount));
    if (!Number.isFinite(amount) || amount<=0) {
      return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
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

    const { rows:sumRows } = await pool.query(`SELECT COALESCE(SUM(applied_amount),0) AS used FROM coupon_ledger WHERE store_id=$1 AND code=$2`, [store_id, code]);
    const used = Number(sumRows[0]?.used||0);
    const cap = (c.cap_total_amount!=null ? Number(c.cap_total_amount)
                : (c.monthly_cap_amount!=null ? Number(c.monthly_cap_amount) : null));
    let cappedAmount = amount;
    if (cap!=null && cap>=0) {
      const remaining = Math.max(0, cap - used);
      if (remaining<=0) return res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
      cappedAmount = Math.min(amount, remaining);
    }

    const checkout_id2 = String(body.checkout_id || body.checkout_token || body.token || '').trim();
    if (checkout_id2) {
      await pool.query(
        `INSERT INTO coupon_ledger (store_id, code, applied_amount, currency, checkout_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (store_id, code, checkout_id) DO UPDATE SET applied_amount=EXCLUDED.applied_amount`,
        [store_id, code, cappedAmount, currency, checkout_id2]
      );
    }

    const label = c.label || `Cupón ${code}`;
    res.json({ commands:[{ command:'create_or_update_discount', specs:{ promotion_id:PROMO_ID, currency, display_text:{ 'es-ar':label }, discount_specs:{ type:'fixed', amount:cappedAmount.toFixed(2) } }}] });
  } catch (e) {
    console.error('discounts/callback error:', e);
    res.json({ commands:[{ command:'delete_discount', specs:{ promotion_id:PROMO_ID } }] });
  }
});

app.post('/webhooks/orders/create', (_req, res) => res.sendStatus(200));

/* ---------- Admin (React build) ---------- */
app.use('/admin', express.static(path.join(__dirname, 'admin/dist'), { maxAge:'1h' }));
app.get('/admin/*', (_req, res) => res.sendFile(path.join(__dirname, 'admin/dist/index.html')));

// ==== Crear tabla campaigns si no existe ====
async function ensureCampaignsTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      store_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT,
      discount_type TEXT CHECK (discount_type IN ('percent', 'absolute')) NOT NULL,
      discount_value NUMERIC NOT NULL,
      valid_from TIMESTAMP,
      valid_until TIMESTAMP,
      apply_scope TEXT DEFAULT 'all',
      include_category_ids TEXT[],
      exclude_category_ids TEXT[],
      include_product_ids TEXT[],
      exclude_product_ids TEXT[],
      max_discount_amount NUMERIC,
      min_cart_amount NUMERIC,
      status TEXT DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `;
  try {
    await pool.query(query);
    console.log("✅ Tabla 'campaigns' verificada o creada correctamente.");
  } catch (err) {
    console.error("❌ Error creando/verificando tabla campaigns:", err);
  }
}
ensureCampaignsTable();

// ==== Rutas ====
app.use('/api/templates', templatesRouter);

// ==== Ping simple ====
app.get('/api/db/ping', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, message: 'DB OK' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ==== Estático (frontend) ====
app.use(express.static(path.join(__dirname, 'admin', 'dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'dist', 'index.html'));
});

// ==== Start ====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});