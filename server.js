// server.js — App Merci Descuentos (TN OAuth + Neon + Campañas c/ categorías)
// ESM + Render estable. Incluye /api/health y /api/db/ping.

import express from "express";
import cookieSession from "cookie-session";
import axios from "axios";
import crypto from "crypto";
import "dotenv/config";      // <- única carga de variables .env (NO duplicar)
import { Pool } from "pg";

// -------------------- DB (Neon) --------------------
const { DATABASE_URL } = process.env;
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// -------------------- App --------------------
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

// -------------------- Salud --------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    data: { status: "ok", node: process.version, time: new Date().toISOString() },
  });
});

// DB ping (opcional)
app.get("/api/db/ping", async (_req, res) => {
  if (!pool) return res.json({ ok: false, error: "DATABASE_URL no configurada" });
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Raíz simple
app.get("/", (_req, res) => res.send("OK"));

// -------------------- Install/OAuth --------------------
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
    `&scope=read_products,read_categories,write_discounts,read_discounts`;

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
    if (!access_token) return res.status(400).send("No se recibió token");

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

// -------------------- API Tiendanube: categorías --------------------
app.get("/api/tn/categories", async (req, res) => {
  try {
    const store_id = String(req.query.store_id || "").trim();
    if (!store_id) return res.status(400).json({ message: "Falta store_id" });

    const r = await pool.query(
      "SELECT access_token FROM stores WHERE store_id=$1 LIMIT 1",
      [store_id]
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ message: "No hay token para esa tienda" });
    }
    const token = r.rows[0].access_token;

    // Tiendanube: Authentication: bearer <token>  + User-Agent obligatorio
    const resp = await axios.get(`https://api.tiendanube.com/v1/${store_id}/categories`, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Merci Descuentos (andres.barba82@gmail.com)",
        "Authentication": `bearer ${token}`,
      },
      params: { per_page: 250 },
    });

    // Normalizar nombre segun idioma
    const cats = (resp.data || []).map((c) => ({
      id: c.id,
      name: c.name?.es || c.name?.pt || c.name?.en || String(c.id),
    }));

    return res.json(cats);
  } catch (e) {
    console.error("GET /api/tn/categories error:", e.response?.data || e.message);
    const status = e.response?.status || 500;
    return res
      .status(status)
      .json({ message: "Error obteniendo categorías", detail: e.response?.data || e.message });
  }
});

// -------------------- Admin (HTML con formulario) --------------------
app.get("/admin", async (req, res) => {
  const store_id = String(req.query.store_id || "").trim();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.end(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Cupones Merci</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,'Helvetica Neue',Arial;padding:24px;max-width:980px;margin:auto;background:#fafafa;color:#111}
  h1{margin:0 0 8px}
  .card{background:#fff;border:1px solid #eee;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.04);padding:16px;margin:16px 0}
  label{display:block;font-size:12px;color:#555;margin-top:10px}
  input,select,textarea{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:8px;margin-top:6px}
  .row{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
  .row3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  button{background:#111;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border-bottom:1px solid #eee;text-align:left;padding:8px}
  .muted{color:#666}
  .multi{min-height:120px}
</style>
</head>
<body>
  <h1>Cupones Merci ${store_id ? ('&mdash; <small class="muted">Tienda <code>' + store_id + '</code></small>') : ''}</h1>
  <p class="muted">Crear y segmentar campañas por categorías.</p>

  <div class="card">
    <h3>Nueva campaña</h3>
    <form id="f">
      <div class="row">
        <div>
          <label>Store ID</label>
          <input name="store_id" value="${store_id || ""}" required />
        </div>
        <div>
          <label>Código del cupón</label>
          <input name="code" placeholder="EJ: GIMNASIO10" required />
        </div>
      </div>

      <label>Nombre interno</label>
      <input name="name" placeholder="EJ: Convenio Gimnasios 10%" required />

      <div class="row">
        <div>
          <label>Tipo de descuento</label>
          <select name="discount_type">
            <option value="percent" selected>%</option>
            <option value="fixed">Monto fijo</option>
          </select>
        </div>
        <div>
          <label>Valor</label>
          <input name="discount_value" type="number" step="1" value="10" required />
        </div>
      </div>

      <div class="row">
        <div>
          <label>Vigencia desde</label>
          <input name="valid_from" type="date" required />
        </div>
        <div>
          <label>Vigencia hasta</label>
          <input name="valid_until" type="date" required />
        </div>
      </div>

      <div class="row3">
        <div>
          <label>Ámbito</label>
          <select name="apply_scope" id="apply_scope">
            <option value="all" selected>Toda la tienda</option>
            <option value="categories">Categorías incluidas</option>
            <option value="products">Productos (próximo)</option>
          </select>
        </div>
        <div>
          <label>Mínimo carrito</label>
          <input name="min_cart_amount" type="number" step="1" value="0" />
        </div>
        <div>
          <label>Excluir productos en oferta</label>
          <select name="exclude_sale_items">
            <option value="false" selected>No</option>
            <option value="true">Sí</option>
          </select>
        </div>
      </div>

      <div id="cats_block" style="display:none">
        <label>Categorías para incluir (Ctrl/Cmd + clic para múltiples)</label>
        <select id="include_categories" class="multi" multiple></select>

        <label style="margin-top:12px">Categorías a excluir</label>
        <select id="exclude_categories" class="multi" multiple></select>
      </div>

      <div style="margin-top:12px;display:flex;gap:10px">
        <button type="submit">Crear campaña</button>
        <button type="button" id="reload">Actualizar lista</button>
      </div>
    </form>
    <div id="msg" class="muted" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <h3>Campañas existentes</h3>
    <div id="list" class="muted">Cargando…</div>
  </div>

<script>
const $ = (s, el=document) => el.querySelector(s);

function toBool(v){ return String(v) === 'true'; }

function selectedIds(sel){
  return Array.from(sel.selectedOptions).map(o => Number(o.value));
}

function formToPayload(form){
  const fd = new FormData(form);
  const payload = {
    store_id: fd.get('store_id'),
    code: fd.get('code'),
    name: fd.get('name'),
    discount_type: fd.get('discount_type'),
    discount_value: Number(fd.get('discount_value')),
    valid_from: fd.get('valid_from'),
    valid_until: fd.get('valid_until'),
    apply_scope: fd.get('apply_scope'),
    min_cart_amount: Number(fd.get('min_cart_amount') || 0),
    exclude_sale_items: toBool(fd.get('exclude_sale_items'))
  };
  if (payload.apply_scope === 'categories') {
    payload.include_category_ids = selectedIds($('#include_categories'));
    payload.exclude_category_ids = selectedIds($('#exclude_categories'));
  }
  return payload;
}

async function api(path, opts){ const r = await fetch(path, opts); const d = await r.json(); if(!r.ok) throw d; return d; }
const listCampaigns = (sid) => api('/api/campaigns?store_id='+encodeURIComponent(sid));
const fetchCategories = (sid) => api('/api/tn/categories?store_id='+encodeURIComponent(sid));

function renderList(rows){
  if(!rows || rows.length === 0){
    $('#list').innerHTML = '<p class="muted">No hay campañas.</p>';
    return;
  }
  $('#list').innerHTML = \`
    <table>
      <thead><tr>
        <th>Nombre</th><th>Código</th><th>Tipo</th><th>Valor</th><th>Ámbito</th><th>Vigencia</th>
      </tr></thead>
      <tbody>
        \${rows.map(r => \`
          <tr>
            <td>\${r.name}</td>
            <td><code>\${r.code}</code></td>
            <td>\${r.discount_type}</td>
            <td>\${r.discount_type === 'percent' ? (r.discount_value + '%') : ('$' + r.discount_value)}</td>
            <td>\${r.apply_scope}</td>
            <td>\${r.valid_from} → \${r.valid_until}</td>
          </tr>\`).join('')}
      </tbody>
    </table>\`;
}

async function refresh(){
  const sid = $('input[name=store_id]').value.trim();
  if(!sid){ $('#list').innerHTML = '<p class="muted">Ingresá Store ID arriba.</p>'; return; }
  $('#list').textContent = 'Cargando…';
  try{
    const data = await listCampaigns(sid);
    renderList(data);
  }catch(e){
    $('#list').innerHTML = '<p class="muted">Error cargando campañas.</p>';
    console.error(e);
  }
}

async function maybeLoadCats(){
  const scope = $('#apply_scope').value;
  const block = $('#cats_block');
  if(scope !== 'categories'){
    block.style.display = 'none';
    return;
  }
  block.style.display = 'block';
  const sid = $('input[name=store_id]').value.trim();
  if(!sid){ $('#msg').textContent = 'Ingresá Store ID para cargar categorías'; return; }
  $('#msg').textContent = 'Cargando categorías…';
  try{
    const cats = await fetchCategories(sid);
    const inc = $('#include_categories'), exc = $('#exclude_categories');
    inc.innerHTML = cats.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
    exc.innerHTML = cats.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
    $('#msg').textContent = '';
  }catch(e){
    console.error(e);
    $('#msg').textContent = 'No se pudieron cargar categorías';
  }
}

$('#apply_scope').addEventListener('change', maybeLoadCats);
$('#f').addEventListener('submit', async (ev)=>{
  ev.preventDefault();
  $('#msg').textContent = 'Creando…';
  try{
    const payload = formToPayload(ev.target);
    await api('/api/campaigns', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    $('#msg').textContent = 'Campaña creada ✅';
    await refresh();
  }catch(e){
    $('#msg').textContent = 'Error: ' + (e.detail || e.message || 'No se pudo crear');
    console.error(e);
  }
});

$('#reload').addEventListener('click', refresh);
window.addEventListener('load', () => { refresh(); });
</script>
</body>
</html>`);
});

// -------------------- API: listar campañas --------------------
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
    console.error("GET /api/campaigns error:", err);
    res.status(500).json({ message: "Error al obtener campañas" });
  }
});

// -------------------- API: crear campaña --------------------
app.post("/api/campaigns", async (req, res) => {
  try {
    const b = req.body || {};

    const store_id = String(b.store_id || "").trim();
    const code = String(b.code || "").trim();
    const name = String(b.name || "").trim();
    if (!store_id || !code || !name) {
      return res.status(400).json({ message: "Faltan store_id, code o name" });
    }

    const discount_type = (b.discount_type || "percent").toLowerCase(); // 'percent' | 'fixed'
    const discount_value_num = Number(b.discount_value ?? 0);

    // Cumplir CHECK(type): 'percentage' | 'absolute'
    const type = discount_type === "percent" ? "percentage" : "absolute";
    // Legacy 'value' (INTEGER NOT NULL)
    const value = Number.isFinite(discount_value_num) ? Math.round(discount_value_num) : 0;

    const valid_from = b.valid_from || new Date().toISOString().slice(0,10);
    const valid_until = b.valid_until || new Date().toISOString().slice(0,10);
    const apply_scope = (b.apply_scope || "all").toString();

    const min_cart_amount = b.min_cart_amount !== undefined ? Number(b.min_cart_amount) : 0;
    const max_discount_amount = b.max_discount_amount !== undefined ? Number(b.max_discount_amount) : null;
    const monthly_cap_amount = b.monthly_cap_amount !== undefined ? Number(b.monthly_cap_amount) : null;
    const exclude_sale_items = b.exclude_sale_items === true ? true : false;

    // Segmentación (opcional)
    const include_category_ids = Array.isArray(b.include_category_ids) ? b.include_category_ids : null;
    const exclude_category_ids = Array.isArray(b.exclude_category_ids) ? b.exclude_category_ids : null;
    const include_product_ids  = Array.isArray(b.include_product_ids)  ? b.include_product_ids  : null;
    const exclude_product_ids  = Array.isArray(b.exclude_product_ids)  ? b.exclude_product_ids  : null;

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
        exclude_sale_items,
        include_category_ids, exclude_category_ids,
        include_product_ids,  exclude_product_ids
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
        $18, $19,
        $20, $21
      )
      RETURNING id, store_id, code, name, created_at
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
      discount_value_num,
      valid_from,
      valid_until,
      apply_scope,
      min_cart_amount,
      max_discount_amount,
      monthly_cap_amount,
      exclude_sale_items,
      include_category_ids,
      exclude_category_ids,
      include_product_ids,
      exclude_product_ids
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

// -------------------- Placeholders seguros --------------------
app.post("/discounts/callback", (_req, res) => res.json({ discounts: [] }));
app.post("/webhooks/orders/create", (_req, res) => res.sendStatus(200));

// -------------------- Start --------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => console.log("Server on :" + PORT));
