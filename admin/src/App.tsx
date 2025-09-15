import React from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";

/**
 * Dashboard inicial de "Página principal" para Merci Descuentos.
 * - Sidebar a la izquierda (menú)
 * - Tarjetas KPI
 * - Gráfico de usos por día (línea)
 * - Ranking de campañas (barras)
 * - Bloques analíticos (stackeo, topes, etc.)
 *
 * TODO (integración):
 *  - Reemplazar MOCK_DATA por fetch al backend
 *  - Conectar KPIs con /api/redemptions y /api/campaigns
 *  - Manejar timezone de la tienda en el backend; aquí sólo visualizamos
 */

// ====== MOCK DATA (reemplazar con datos reales del backend) ======
const MOCK_KPIS = {
  monthLabel: "Septiembre 2025",
  montoTotalDescontado: 428450, // en ARS
  pedidosConDescuento: 286,
  clientesBeneficiados: 241,
  topCampania: { name: "10% en Secos", share: 0.42 },
  variacionVsMesAnterior: {
    monto: +0.18, // +18%
    usos: +0.11, // +11%
  },
  descuentoPromedioPorPedido: 1498,
  porcentajePedidosConCupon: 0.12, // 12%
  ticketPromedioCon: 9870,
  ticketPromedioSin: 11240,
  stackeo: {
    soloNativo: 0.21,
    soloApp: 0.68,
    ambos: 0.11,
  },
  topes: {
    campañasConBajoMargen: [
      { name: "Secos 10%", restante: 0.16 },
      { name: "Mixes -$500", restante: 0.22 },
    ],
    clientesAlTope: 7,
  },
};

// Usos por día del mes (línea)
const MOCK_USOS_DIA = Array.from({ length: 30 }).map((_, i) => ({
  dia: `${i + 1}`.padStart(2, "0"),
  usos: Math.floor(4 + Math.random() * 20),
}));

// Ranking de campañas por monto descontado (barras)
const MOCK_RANKING = [
  { name: "10% en Secos", monto: 178320 },
  { name: "-$500 Mixes", monto: 94500 },
  { name: "15% Snacks", monto: 70880 },
  { name: "$1000 Bebidas", monto: 54600 },
  { name: "2x1 Barritas", monto: 30450 },
];

// ====== Helper UI ======
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
  return (
    <span>
      ${" "}
      {amount.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
    </span>
  );
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

// ====== Sidebar ======
function Sidebar() {
  const items = [
    { label: "Página principal", active: true },
    { label: "Campañas" },
    { label: "Categorías" },
    { label: "Redenciones" },
    { label: "Clientes" },
    { label: "Configuración" },
    { label: "Salud & Logs" },
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
            <a
              key={it.label}
              className={`block rounded-xl px-3 py-2 text-sm font-medium ${
                it.active
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-700 hover:bg-slate-50"
              }`}
              href="#"
            >
              {it.label}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}

// ====== Main Dashboard ======
export default function Dashboard() {
  const k = MOCK_KPIS;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex max-w-7xl">
        <Sidebar />
        <main className="flex-1 p-4 sm:p-6">
          {/* Header */}
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Página principal</h1>
              <p className="text-sm text-slate-500">Resumen analítico — {k.monthLabel}</p>
            </div>
            <div className="flex items-center gap-2">
              <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:bg-slate-50">Exportar CSV</button>
              <button className="rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">Crear campaña</button>
            </div>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card
              title="Monto total descontado"
              value={<Peso amount={k.montoTotalDescontado} />}
              subtitle="Suma de descuentos aplicados en el mes"
              extra={<div className="text-xs text-slate-500">Vs. mes anterior <Trend value={k.variacionVsMesAnterior.monto} /></div>}
            />
            <Card
              title="Pedidos con descuento"
              value={k.pedidosConDescuento}
              subtitle="Órdenes con al menos 1 cupón"
              extra={<div className="text-xs text-slate-500">Vs. mes anterior <Trend value={k.variacionVsMesAnterior.usos} /></div>}
            />
            <Card
              title="Clientes beneficiados"
              value={k.clientesBeneficiados}
              subtitle="Únicos en el mes"
            />
            <Card
              title="Top campaña activa"
              value={`${k.topCampania.name}`}
              subtitle={`Participación ${Math.round(k.topCampania.share * 100)}%`}
            />
          </div>

          {/* Evolución diaria */}
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

          {/* Ranking campañas + Stackeo */}
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
              <div className="mt-4 text-xs text-slate-500">
                Ayuda a entender si la app aporta valor adicional o se solapa con TN.
              </div>
            </Section>

            <Section title="KPIs de ticket">
              <div className="grid grid-cols-2 gap-3">
                <Card title="Descuento prom. por pedido" value={<Peso amount={k.descuentoPromedioPorPedido} />} />
                <Card title="% pedidos con cupón" value={`${Math.round(k.porcentajePedidosConCupon * 100)}%`} />
                <Card title="Ticket con descuento" value={<Peso amount={k.ticketPromedioCon} />} />
                <Card title="Ticket sin descuento" value={<Peso amount={k.ticketPromedioSin} />} />
              </div>
            </Section>
          </div>

          {/* Topes y alertas */}
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
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-4 text-rose-800">
                  <div className="text-3xl font-bold">{k.topes.clientesAlTope}</div>
                  <div className="text-sm mt-1">clientes alcanzaron su tope este mes</div>
                </div>
              </div>
            </div>
          </Section>

          {/* Footer */}
          <div className="mt-8 text-center text-xs text-slate-400">© {new Date().getFullYear()} Merci Descuentos — Página principal</div>
        </main>
      </div>
    </div>
  );
}

