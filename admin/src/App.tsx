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
type Campaign = {
  id: string | number;
  code: string;
  name?: string;
  status?: "active" | "paused" | "deleted" | string;
  discount_type?: string;      // 'percent' | 'absolute'
  discount_value?: string | number;
  valid_from?: string | null;
  valid_until?: string | null;
  created_at?: string;
};

/* ========= API helpers (acciones) ========= */
async function apiPatch(url: string, body: any) {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${url} → ${r.status}`);
  return r.json();
}
async function apiDelete(url: string) {
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE ${url} → ${r.status}`);
  return r.json();
}
function statusBadge(s?: string) {
  const base = "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium";
  if (s === "active")  return <span className={`${base} bg-emerald-50 text-emerald-700 border border-emerald-200`}>Activo</span>;
  if (s === "paused")  return <span className={`${base} bg-slate-100 text-slate-600 border border-slate-200`}>Pausado</span>;
  if (s === "deleted") return <span className={`${base} bg-rose-50 text-rose-700 border border-rose-200`}>Eliminado</span>;
  return <span className={`${base} bg-slate-50 text-slate-500 border border-slate-200`}>{s || "-"}</span>;
}

/* ========= Sidebar & router por estado ========= */
type ViewName = "home" | "campaigns" | "coupons" | "categories" | "redemptions" | "clients" | "logs";
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

        <Section title="KPIs de ticket">
          <div className="grid grid-cols-2 gap-3">
            <Card title="Descuento prom. por pedido" value={<Peso amount={k.descuentoPromedioPorPedido} />} />
            <Card title="% pedidos con cupón" value={`${Math.round(k.porcentajePedidosConCupon * 100)}%`} />
            <Card title="Ticket con descuento" value={<Peso amount={k.ticketPromedioCon} />} />
            <Card title="Ticket sin descuento" value={<Peso amount={k.ticketPromedioSin} />} />
          </div>
        </Section>

        <Section title="Topes y alertas">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Campañas con bajo margen</div>
              <ul className="space-y-2">
                {MOCK_KPIS.topes.campañasConBajoMargen.map((c) => (
                  <li key={c.name} className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                    <span>{c.name}</span>
                    <span className="text-sm">{Math.round(c.restante * 100)}% restante</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Clientes al tope mensual</div>
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-4 text-rose-800">
                <div className="text-3xl font-bold">{MOCK_KPIS.topes.clientesAlTope}</div>
                <div className="text-sm mt-1">clientes alcanzaron su tope este mes</div>
              </div>
            </div>
          </div>
        </Section>
      </div>
    </>
  );
}

/* ========= Vista: Campañas (tabla simple + CTA cupones) ========= */
function CampaignsView({ storeId, onGoCoupons }: { storeId: string; onGoCoupons: () => void }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Campañas</h1>
        <div className="flex items-center gap-2">
          <button onClick={onGoCoupons} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-slate-50">
            Cupones
          </button>
          <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
            Crear campaña
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-0 overflow-hidden shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600">
          {loading ? "Cargando…" : `${rows.length} campañas encontradas`}
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
              {!loading && rows.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-500" colSpan={6}>No hay campañas.</td></tr>
              )}
              {rows.map((c) => {
                const tipo = c.discount_type === "percent" ? "Porcentaje" : c.discount_type === "absolute" ? "Monto fijo" : (c as any).type || "-";
                const valor = typeof c.discount_value !== "undefined"
                  ? c.discount_type === "percent"
                    ? `${Number(c.discount_value)}%`
                    : `$ ${Number(c.discount_value).toLocaleString("es-AR")}`
                  : (c as any).value ?? "-";
                const vigencia = [
                  c.valid_from ? new Date(c.valid_from).toLocaleDateString("es-AR") : null,
                  c.valid_until ? new Date(c.valid_until).toLocaleDateString("es-AR") : null,
                ].filter(Boolean).join(" → ");

                return (
                  <tr key={String(c.id)} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono">{c.code}</td>
                    <td className="px-4 py-2">{c.name || "-"}</td>
                    <td className="px-4 py-2">{tipo}</td>
                    <td className="px-4 py-2">{valor}</td>
                    <td className="px-4 py-2">{statusBadge(c.status)}</td>
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

/* ========= Vista: Cupones (con Pausar/Reanudar + Eliminar) ========= */
function CouponsView({ storeId }: { storeId: string }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Campaign[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const onToggle = async (c: Campaign) => {
    try {
      const next = c.status === "active" ? "paused" : "active";
      await apiPatch(`/api/campaigns/${c.id}/status`, { status: next });
      setRows(prev => prev.map(x => x.id === c.id ? { ...x, status: next } : x));
    } catch (e: any) {
      alert(`Error al actualizar estado: ${e.message || e}`);
    }
  };
  const onDelete = async (c: Campaign) => {
    try {
      if (!confirm(`¿Eliminar el cupón/campaña "${c.code}"?`)) return;
      await apiDelete(`/api/campaigns/${c.id}`);
      setRows(prev => prev.filter(x => x.id !== c.id));
    } catch (e: any) {
      alert(`Error al eliminar: ${e.message || e}`);
    }
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

      <div className="rounded-2xl border border-slate-200 bg-white p-0 overflow-hidden shadow-sm">
        <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600">
          {loading ? "Cargando…" : `${rows.length} cupones mostrados`}
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
                <th className="px-4 py-2 text-left">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr><td className="px-4 py-4 text-slate-500" colSpan={7}>No hay cupones.</td></tr>
              )}
              {rows.map((c) => {
                const tipo = c.discount_type === "percent" ? "Porcentaje" : c.discount_type === "absolute" ? "Monto fijo" : (c as any).type || "-";
                const valor = typeof c.discount_value !== "undefined"
                  ? c.discount_type === "percent"
                    ? `${Number(c.discount_value)}%`
                    : `$ ${Number(c.discount_value).toLocaleString("es-AR")}`
                  : (c as any).value ?? "-";
                const vigencia = [
                  c.valid_from ? new Date(c.valid_from).toLocaleDateString("es-AR") : null,
                  c.valid_until ? new Date(c.valid_until).toLocaleDateString("es-AR") : null,
                ].filter(Boolean).join(" → ");

                return (
                  <tr key={String(c.id)} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-mono">{c.code}</td>
                    <td className="px-4 py-2">{c.name || "-"}</td>
                    <td className="px-4 py-2">{tipo}</td>
                    <td className="px-4 py-2">{valor}</td>
                    <td className="px-4 py-2">{statusBadge(c.status)}</td>
                    <td className="px-4 py-2">{vigencia || "-"}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button
                          onClick={() => onToggle(c)}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs hover:bg-slate-50"
                          title={c.status === "active" ? "Pausar" : "Reanudar"}
                        >
                          {c.status === "active" ? "Pausar" : "Reanudar"}
                        </button>
                        <button
                          onClick={() => onDelete(c)}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-rose-700"
                          title="Eliminar"
                        >
                          Eliminar
                        </button>
                      </div>
                    </td>
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
  const initialView = (new URLSearchParams(window.location.search).get("view") as ViewName) || "home";
  const [view, setView] = useState<ViewName>(initialView);

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
              ? <CampaignsView storeId={storeId} onGoCoupons={() => setView("coupons")} />
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
