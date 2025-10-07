import React, { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, BarChart, Bar, Legend,
} from "recharts";

/* ========= Utilitarios UI ========= */
function Trend({ value }: { value: number }) {
  const isUp = value >= 0;
  const pct = Math.round(Math.abs(value) * 100);
  return (
    <span className={`ml-2 inline-flex items-center text-sm ${isUp ? "text-emerald-600" : "text-rose-600"}`}>
      {isUp ? (
        <svg className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor"><path d="M3 12l5-5 4 4 5-5v6h-2V8.414l-3 3-4-4L5 13H3z"/></svg>
      ) : (
        <svg className="h-4 w-4 mr-1" viewBox="0 0 20 20" fill="currentColor"><path d="M3 8l5 5 4-4 5 5V8h-2v3.586l-3-3-4 4L5 7H3z"/></svg>
      )}
      {isUp ? "+" : "-"}{pct}%
    </span>
  );
}
function Peso({ amount }: { amount: number }) {
  return <span>${" "}{amount.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>;
}
function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {right}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">{children}</div>
    </section>
  );
}
function Card({ title, value, subtitle, extra }: { title: string; value: React.ReactNode; subtitle?: string; extra?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
      {subtitle && <div className="mt-1 text-xs text-slate-500">{subtitle}</div>}
      {extra && <div className="mt-3">{extra}</div>}
    </div>
  );
}
function Badge({ children, color = "gray" }: { children: React.ReactNode; color?: "green"|"gray"|"red" }) {
  const map = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    gray: "bg-slate-50 text-slate-700 border-slate-200",
    red: "bg-rose-50 text-rose-700 border-rose-200",
  } as const;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${map[color]}`}>
      {children}
    </span>
  );
}

/* ========= Datos mock “Principal” ========= */
const MOCK_KPIS = {
  monthLabel: "Septiembre 2025",
  montoTotalDescontado: 428450,
  pedidosConDescuento: 286,
  clientesBeneficiados: 241,
  topCampania: { name: "10% en Secos", share: 0.42 },
  variacionVsMesAnterior: { monto: +0.18, usos: +0.11 },
  descuentoPromedioPorPedido: 1498,
  porcentajePedidosConCupon: 0.12,
  ticketPromedioCon: 9870,
  ticketPromedioSin: 11240,
  stackeo: { soloNativo: 0.21, soloApp: 0.68, ambos: 0.11 },
  topes: { campañasConBajoMargen: [{ name: "Secos 10%", restante: 0.16 }, { name: "Mixes -$500", restante: 0.22 }], clientesAlTope: 7 },
};
const MOCK_USOS_DIA = Array.from({ length: 30 }).map((_, i) => ({ dia: `${i + 1}`.padStart(2, "0"), usos: Math.floor(4 + Math.random() * 20) }));
const MOCK_RANKING = [
  { name: "10% en Secos", monto: 178320 },
  { name: "-$500 Mixes", monto: 94500 },
  { name: "15% Snacks", monto: 70880 },
  { name: "$1000 Bebidas", monto: 54600 },
  { name: "2x1 Barritas", monto: 30450 },
];

/* ========= Helpers ========= */
function useQueryParam(name: string) {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  return params.get(name);
}

/* ========= Sidebar & router por estado ========= */
type ViewName =
  | "home"
  | "campaigns"
  | "coupons"
  | "bogo"
  | "category_percent"
  | "category_fixed"
  | "free_shipping"
  | "categories"
  | "redemptions"
  | "clients"
  | "logs";

function Sidebar({ current, onChange }: { current: ViewName; onChange: (v: ViewName) => void }) {
  const items: { key: ViewName; label: string }[] = [
    { key: "home", label: "Principal" },
    { key: "campaigns", label: "Campañas" },
    { key: "categories", label: "Categorías" },
    { key: "redemptions", label: "Redenciones" },
    { key: "clients", label: "Clientes" },
    { key: "logs", label: "Salud & Logs" },
  ];
  return (
    <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 bg-white/70 backdrop-blur">
      <div className="px-5 py-4">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-blue-600 text-white grid place-items-center font-bold">M</div>
          <div>
            <div className="font-semibold leading-tight">Merci Descuentos</div>
            <div className="text-xs text-slate-500">Panel de administración</div>
          </div>
        </div>
        <nav className="space-y-1">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => onChange(it.key)}
              className={`w-full text-left rounded-xl px-3 py-2 text-sm font-medium ${
                current === it.key ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              {it.label}
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}

/* ========= Vista Principal ========= */
function HomeView() {
  const k = MOCK_KPIS;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Principal</h1>
          <p className="text-sm text-slate-500">Resumen analítico — {k.monthLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-slate-50">Exportar CSV</button>
          <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">Crear campaña</button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card title="Monto total descontado" value={<Peso amount={k.montoTotalDescontado} />} subtitle="Suma de descuentos aplicados en el mes" extra={<div className="text-xs text-slate-500">Vs. mes anterior <Trend value={k.variacionVsMesAnterior.monto} /></div>} />
        <Card title="Pedidos con descuento" value={k.pedidosConDescuento} subtitle="Órdenes con al menos 1 cupón" extra={<div className="text-xs text-slate-500">Vs. mes anterior <Trend value={k.variacionVsMesAnterior.usos} /></div>} />
        <Card title="Clientes beneficiados" value={k.clientesBeneficiados} subtitle="Únicos en el mes" />
        <Card title="Top campaña activa" value={`${k.topCampania.name}`} subtitle={`Participación ${Math.round(k.topCampania.share * 100)}%`} />
      </div>

      <Section title="Usos por día">
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={MOCK_USOS_DIA} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="dia" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <RTooltip formatter={(v: number) => [`${v} usos`, "Usos"]} labelFormatter={(l) => `Día ${l}`} />
              <Line type="monotone" dataKey="usos" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Section title="Ranking de campañas por monto descontado" right={<span className="text-xs text-slate-500">Mes actual</span>}>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={MOCK_RANKING} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Legend />
                <RTooltip formatter={(v: number) => [`$ ${v.toLocaleString("es-AR")}`, "Monto"]} />
                <Bar dataKey="monto" name="Monto descontado" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Stackeo con cupones nativos">
          <div className="grid grid-cols-3 gap-3">
            <Card title="Solo nativo" value={`${Math.round(MOCK_KPIS.stackeo.soloNativo * 100)}%`} />
            <Card title="Solo app" value={`${Math.round(MOCK_KPIS.stackeo.soloApp * 100)}%`} />
            <Card title="Ambos" value={`${Math.round(MOCK_KPIS.stackeo.ambos * 100)}%`} />
          </div>
          <div className="mt-4 text-xs text-slate-500">Ayuda a entender si la app aporta valor adicional o se solapa con TN.</div>
        </Section>

        <Section title="Topes y alertas">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Campañas con bajo margen</div>
              <ul className="space-y-2">
                {k.topes.campañasConBajoMargen.map((c) => (
                  <li key={c.name} className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                    <span>{c.name}</span>
                    <span className="text-sm">{Math.round(c.restante * 100)}% restante</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Clientes al tope mensual</div>
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-4 text-rose-800">
                <div className="text-3xl font-bold">{k.topes.clientesAlTope}</div>
                <div className="text-sm mt-1">clientes alcanzaron su tope este mes</div>
              </div>
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

/* ========= Botón grande para tipos de campaña ========= */
function CampaignTypeCard({
  title,
  desc,
  onClick,
  icon,
}: {
  title: string;
  desc: string;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="group h-36 w-full rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-50 text-blue-600">
          {icon ?? (
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M21 7h-7l-2-2H3a1 1 0 0 0-1 1v5a2 2 0 1 0 0 4v5a1 1 0 0 0 1 1h9l2-2h7a1 1 0 0 0 1-1v-4a2 2 0 1 1 0-4V8a1 1 0 0 0-1-1zM6.5 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
            </svg>
          )}
        </div>
        <div className="flex-1">
          <div className="text-base font-semibold text-slate-900">{title}</div>
          <div className="mt-1 text-sm text-slate-600">{desc}</div>
          <div className="mt-3 text-sm font-medium text-blue-700 opacity-0 transition group-hover:opacity-100">
            Entrar →
          </div>
        </div>
      </div>
    </button>
  );
}

/* ========= Vista: Campañas (HUB con botones grandes) ========= */
function CampaignsView({
  storeId,
  onNavigate,
}: {
  storeId: string;
  onNavigate: (v: ViewName) => void;
}) {
  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Campañas</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <CampaignTypeCard
          title="Cupones"
          desc="Códigos de descuento en % o monto fijo."
          onClick={() => onNavigate("coupons")}
          icon={
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M21 7h-7l-2-2H3a1 1 0 0 0-1 1v5a2 2 0 1 0 0 4v5a1 1 0 0 0 1 1h9l2-2h7a1 1 0 0 0 1-1v-4a2 2 0 1 1 0-4V8a1 1 0 0 0-1-1zM6.5 13a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
            </svg>
          }
        />
        <CampaignTypeCard
          title="2×1 (BOGO)"
          desc="Lleva 2, paga 1. Ideal para combos."
          onClick={() => onNavigate("bogo")}
        />
        <CampaignTypeCard
          title="% por categoría"
          desc="Descuento por rubros específicos."
          onClick={() => onNavigate("category_percent")}
        />
        <CampaignTypeCard
          title="Monto fijo por categoría"
          desc="Descuento fijo para categorías."
          onClick={() => onNavigate("category_fixed")}
        />
        <CampaignTypeCard
          title="Envío gratis"
          desc="Promos de envío sin costo."
          onClick={() => onNavigate("free_shipping")}
        />
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
        Elegí un tipo de campaña. <b>Cupones</b> te lleva al listado actual; los demás están “en construcción”.
        {storeId ? null : (
          <span className="ml-2 text-rose-600">
            • Falta <code>store_id</code> en la URL para operar.
          </span>
        )}
      </div>
    </>
  );
}

/* ========= Tipos ========= */
type CampaignRow = {
  id: string | number;
  code: string;
  name?: string;
  status?: string;
  discount_type?: string;
  discount_value?: string | number;
  valid_from?: string | null;
  valid_until?: string | null;
  created_at?: string;
};

/* ========= Vista: Cupones (mejorada) ========= */
function CouponsView({ storeId }: { storeId: string }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  // filtros
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "paused" | "expired">("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const url = useMemo(() => `/api/campaigns?store_id=${encodeURIComponent(storeId)}`, [storeId]);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancel) setRows(Array.isArray(data) ? data : []);
      })
      .catch((e) => !cancel && setError(String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, [url]);

  const filtered = useMemo(() => {
    const norm = (s: unknown) => String(s ?? "").toLowerCase();
    const inRange = (d: string | null | undefined) => {
      if (!d) return true;
      const dv = d.slice(0, 10);
      if (from && dv < from) return false;
      if (to && dv > to) return false;
      return true;
    };
    const isExpired = (row: CampaignRow) => {
      const today = new Date().toISOString().slice(0,10);
      return !!row.valid_until && today > row.valid_until;
    };

    return rows.filter(r => {
      if (q) {
        const hit = norm(r.code).includes(q.toLowerCase()) || norm(r.name).includes(q.toLowerCase());
        if (!hit) return false;
      }
      if (status) {
        if (status === "expired") {
          if (!isExpired(r)) return false;
        } else {
          if ((r.status || "").toLowerCase() !== status) return false;
        }
      }
      if (!inRange(r.valid_from) || !inRange(r.valid_until)) return false;
      return true;
    });
  }, [rows, q, status, from, to]);

  const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString("es-AR") : "-");
  const fmtValor = (row: CampaignRow) => {
    if (typeof row.discount_value !== "undefined" && row.discount_type) {
      return row.discount_type === "percent"
        ? `${Number(row.discount_value)}%`
        : `$ ${Number(row.discount_value).toLocaleString("es-AR")}`;
    }
    return "-";
  };
  const statusBadge = (row: CampaignRow) => {
    const today = new Date().toISOString().slice(0,10);
    if (row.valid_until && today > row.valid_until) return <Badge color="red">Vencido</Badge>;
    const st = (row.status || "").toLowerCase();
    if (st === "active") return <Badge color="green">Activo</Badge>;
    if (st === "paused") return <Badge color="gray">Pausado</Badge>;
    return <Badge color="gray">{row.status || "-"}</Badge>;
  };
  const copyCode = async (code: string) => {
    try { await navigator.clipboard.writeText(code); } catch {}
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Cupones</h1>
        <div className="flex items-center gap-2">
          <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-slate-50">
            Instalar/Verificar script
          </button>
          <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
            Crear cupón
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por código o nombre…"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
          />
        </div>
        <div className="md:col-span-3">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
          >
            <option value="">Estado: todos</option>
            <option value="active">Activo</option>
            <option value="paused">Pausado</option>
            <option value="expired">Vencido</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            placeholder="Desde"
          />
        </div>
        <div className="md:col-span-2">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            placeholder="Hasta"
          />
        </div>
        <div className="md:col-span-1">
          <button
            onClick={() => { setQ(""); setStatus(""); setFrom(""); setTo(""); }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-slate-50"
          >
            Limpiar
          </button>
        </div>
      </div>

      {/* Tabla */}
      <div className="rounded-2xl border border-slate-200 bg-white p-0 overflow-hidden shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600">
          {loading ? "Cargando…" : `${filtered.length} cupones mostrados`}
          {error && <span className="ml-2 text-rose-600">• Error: {error}</span>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2 text-left">Código</th>
                <th className="px-4 py-2 text-left">Nombre</th>
                <th className="px-4 py-2 text-left">Tipo</th>
                <th className="px-4 py-2 text-left">Valor</th>
                <th className="px-4 py-2 text-left">Estado</th>
                <th className="px-4 py-2 text-left">Vigencia</th>
              </tr>
            </thead>
            <tbody>
              {!loading && filtered.length === 0 && (
                <tr><td className="px-4 py-6 text-slate-500" colSpan={6}>No hay cupones según los filtros.</td></tr>
              )}
              {filtered.map((c) => {
                const tipo = c.discount_type === "percent" ? "Porcentaje" : c.discount_type === "absolute" ? "Monto fijo" : "-";
                const vigencia = [fmtDate(c.valid_from || null), fmtDate(c.valid_until || null)].filter(x => x !== "-").join(" → ");
                return (
                  <tr key={String(c.id)} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono">
                      <button onClick={() => copyCode(c.code)} title="Copiar código" className="underline decoration-dotted">
                        {c.code}
                      </button>
                    </td>
                    <td className="px-4 py-2">{c.name || "-"}</td>
                    <td className="px-4 py-2">{tipo}</td>
                    <td className="px-4 py-2">{fmtValor(c)}</td>
                    <td className="px-4 py-2">{statusBadge(c)}</td>
                    <td className="px-4 py-2">{vigencia || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ========= App principal ========= */
export default function App() {
  // vista actual: si en la URL viene ?view=..., arrancamos ahí; si no, “home”
  const initialView = (new URLSearchParams(window.location.search).get("view") as ViewName) || "home";
  const [view, setView] = useState<ViewName>(initialView);

  // mantener sincronizado el parámetro ?view=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", view);
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", newUrl);
  }, [view]);

  const storeId = useQueryParam("store_id") || "";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex max-w-7xl">
        <Sidebar current={view} onChange={setView} />
        <main className="flex-1 p-4 sm:p-6">
          {view === "home" && <HomeView />}

          {view === "campaigns" && (
            storeId
              ? <CampaignsView storeId={storeId} onNavigate={(v) => setView(v)} />
              : <div className="text-sm text-rose-600">Falta <code>store_id</code> en la URL.</div>
          )}

          {view === "coupons" && (
            storeId
              ? <CouponsView storeId={storeId} />
              : <div className="text-sm text-rose-600">Falta <code>store_id</code> en la URL.</div>
          )}

          {view !== "home" && view !== "campaigns" && view !== "coupons" && (
            <div className="text-sm text-slate-500">Vista “{view}” en construcción.</div>
          )}

          <div className="mt-8 text-center text-xs text-slate-400">© {new Date().getFullYear()} Merci Descuentos</div>
        </main>
      </div>
    </div>
  );
}
