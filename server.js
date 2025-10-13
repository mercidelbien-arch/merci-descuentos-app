// server.js — Express ESM limpio y consistente
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieSession from 'cookie-session';
import axios from 'axios';
import crypto from 'crypto';

import templatesRouter from './api/routes/templates.js';
import { pool } from './db.js'; // ✅ pool único

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

/* ---------- Migraciones (una sola versión coherente) ---------- */
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
    store_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',

    discount_type TEXT CHECK (discount_type IN ('percent','absolute')) NOT NULL,
    discount_value NUMERIC NOT NULL,

    valid_from DATE,
    valid_until DATE,
    apply_scope TEXT DEFAULT 'all',
    min_cart_amount NUMERIC DEFAULT 0,
    max_discount_amount NUMERIC,
    monthly_cap_amount NUMERIC,
    exclude_sale_items BOOLEAN DEFAULT false,

    include_category_ids JSONB,
    exclude_category_ids JSONB,
    include_product_ids  JSONB,
    exclude_product_ids  JSONB,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),

    UNIQUE (store_id, code)
  );
`;
await pool.query(MIGRATE_SQL);

/* ---------- Redirección al admin con store_id por defecto ---------- */
app.get('/', (_req, res) => res.redirect('/admin/?store_id=3739596'));

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

/* ---------- Tiendanube helpers (categorías / productos / scripts) ---------- */
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
    res.status(e.response?.status || 500).json({ message:'Error obteniendo categorías' });
  }
});

app.get('/api/tn/products/search', async (req, res) => {
  try {
    const store_id = String(req.query.store_id || '').trim();
    const q = String(req.query.q || '').trim();
    if (!store_id) return res.status(400).json({ message: 'Falta store_id' });
    if (q.length < 2) return res.json([]);

    const r = await pool.query('SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1', [store_id]);
    if (r.rowCount === 0) return res.status(401).json({ message: 'No hay token para esa tienda' });

    const resp = await axios.get(`${tnBase(store_id)}/products`, {
      headers: tnHeaders(r.rows[0].access_token),
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

/* ---------- Campañas CRUD (persistente) ---------- */
// LISTAR (oculta 'deleted')
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

// OBTENER UNO
app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const store_id = String(req.query.store_id || '').trim();
    if (!id) return res.status(400).json({ error:'Falta id' });
    const { rows } = await pool.query(
      `SELECT * FROM campaigns WHERE id=$1 ${store_id ? 'AND store_id=$2' : ''} LIMIT 1`,
      store_id ? [id, store_id] : [id]
    );
    if (rows.length === 0) return res.status(404).json({ error:'Cupón no encontrado' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error:'Error interno' }); }
});

// CREAR
app.post('/api/campaigns', async (req, res) => {
  try {
    const {
      store_id, code, name,
      discount_type, discount_value,
      valid_from, valid_until,
      apply_scope = 'all',
      include_category_ids = [],
      exclude_category_ids = [],
      include_product_ids  = [],
      exclude_product_ids  = [],
      max_discount_amount = null,
      min_cart_amount = 0,
      monthly_cap_amount = null,
      exclude_sale_items = false,
    } = req.body || {};

    if (!store_id) return res.status(400).json({ error:'Falta store_id' });
    if (!code) return res.status(400).json({ error:'Falta code' });
    if (!discount_type || !['percent','absolute'].includes(String(discount_type))) {
      return res.status(400).json({ error:'discount_type inválido' });
    }

    const { rows } = await pool.query(
      `INSERT INTO campaigns (
        store_id, code, name, status,
        discount_type, discount_value,
        valid_from, valid_until, apply_scope,
        include_category_ids, exclude_category_ids,
        include_product_ids,  exclude_product_ids,
        max_discount_amount, min_cart_amount, monthly_cap_amount, exclude_sale_items
      ) VALUES (
        $1,$2,$3,'active',
        $4,$5,
        $6,$7,$8,
        $9,$10,$11,$12,
        $13,$14,$15,$16
      )
      RETURNING *`,
      [
        store_id, code, (name || code),
        discount_type, Number(discount_value),
        valid_from || null, valid_until || null, apply_scope,
        JSON.stringify(include_category_ids), JSON.stringify(exclude_category_ids),
        JSON.stringify(include_product_ids),  JSON.stringify(exclude_product_ids),
        max_discount_amount, min_cart_amount, monthly_cap_amount, exclude_sale_items
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) { console.error('POST /api/campaigns', e); res.status(500).json({ error:'Error creando cupón' }); }
});

// ACTUALIZAR
app.put('/api/campaigns/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error:'Falta id' });

    const {
      store_id, code, name,
      discount_type, discount_value,
      valid_from, valid_until,
      apply_scope = 'all',
      include_category_ids = [],
      exclude_category_ids = [],
      include_product_ids  = [],
      exclude_product_ids  = [],
      max_discount_amount = null,
      min_cart_amount = 0,
      monthly_cap_amount = null,
      exclude_sale_items = false,
      status = 'active',
    } = req.body || {};

    if (!store_id) return res.status(400).json({ error:'Falta store_id' });

    const { rows, rowCount } = await pool.query(
      `UPDATE campaigns SET
         code=$1, name=$2, status=$3,
         discount_type=$4, discount_value=$5,
         valid_from=$6, valid_until=$7, apply_scope=$8,
         include_category_ids=$9, exclude_category_ids=$10,
         include_product_ids=$11,  exclude_product_ids=$12,
         max_discount_amount=$13, min_cart_amount=$14, monthly_cap_amount=$15,
         exclude_sale_items=$16, updated_at=now()
       WHERE id=$17 AND store_id=$18
       RETURNING *`,
      [
        code, (name || code), status,
        discount_type, Number(discount_value),
        valid_from || null, valid_until || null, apply_scope,
        JSON.stringify(include_category_ids), JSON.stringify(exclude_category_ids),
        JSON.stringify(include_product_ids),  JSON.stringify(exclude_product_ids),
        max_discount_amount, min_cart_amount, monthly_cap_amount,
        exclude_sale_items, id, store_id
      ]
    );
    if (rowCount === 0) return res.status(404).json({ error:'Cupón no encontrado' });
    res.json(rows[0]);
  } catch (e) { console.error('PUT /api/campaigns/:id', e); res.status(500).json({ error:'Error actualizando cupón' }); }
});

// CAMBIAR ESTADO
app.patch('/api/campaigns/:id/status', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const next = String(req.body?.status || '').trim().toLowerCase();
    if (!id) return res.status(400).json({ ok:false, error:'Falta id' });
    if (!['active','paused'].includes(next)) return res.status(400).json({ ok:false, error:'Estado inválido (active|paused)' });
    const r = await pool.query(
      `UPDATE campaigns SET status=$2, updated_at=now() WHERE id=$1 RETURNING id, code, status`,
      [id, next]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok:false, error:'No existe la campaña' });
    res.json({ ok:true, campaign:r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error:e.message }); }
});

// ELIMINAR
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

/* ---------- Start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
