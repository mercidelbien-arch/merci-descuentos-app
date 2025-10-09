import { useEffect, useState } from "react";

export type CouponForm = {
  id?: string;
  store_id: string;
  code: string;
  // name oculto: usamos code como nombre “humano”
  discount_type: "percent" | "absolute";
  discount_value: number;
  valid_from: string;   // yyyy-mm-dd
  valid_until: string;  // yyyy-mm-dd
  apply_scope: "all" | "categories" | "products";
  include_category_ids?: number[];
  exclude_category_ids?: number[];
  include_product_ids?: number[];
  exclude_product_ids?: number[];
  max_discount_amount?: number;
  min_cart_amount?: number;
};

function toInputDate(d?: string | null) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromInputDate(d: string) {
  return d || "";
}

type Props = {
  storeId: string;
  couponId: string | null; // "new" en el llamador se transforma a null
  onClose: () => void;
  onSaved: () => void;
};

export default function CouponEditor({ storeId, couponId, onClose, onSaved }: Props) {
  const isEditing = Boolean(couponId);

  const [form, setForm] = useState<CouponForm>({
    id: undefined,
    store_id: storeId,
    code: "",
    discount_type: "percent",
    discount_value: 10,
    valid_from: "",
    valid_until: "",
    apply_scope: "all",
    include_category_ids: [],
    exclude_category_ids: [],
    include_product_ids: [],
    exclude_product_ids: [],
    max_discount_amount: undefined,
    min_cart_amount: undefined,
  });

  const [loading, setLoading] = useState<boolean>(!!couponId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============ Carga en edición ============
  useEffect(() => {
    if (!couponId) return;
    setLoading(true);
    setError(null);

    // Intentamos con store_id como query por compatibilidad
    const url = `/api/campaigns/${encodeURIComponent(couponId)}?store_id=${encodeURIComponent(
      storeId
    )}`;

    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const c = await r.json();

        // Adaptamos al formulario
        const loaded: CouponForm = {
          id: String(c.id),
          store_id: storeId,
          code: c.code ?? "",
          discount_type: (c.discount_type ?? "percent") as "percent" | "absolute",
          discount_value: Number(c.discount_value ?? 0),
          valid_from: toInputDate(c.valid_from ?? c.start_date),
          valid_until: toInputDate(c.valid_until ?? c.end_date),
          apply_scope: (c.apply_scope ?? "all") as "all" | "categories" | "products",
          include_category_ids: c.include_category_ids ?? [],
          exclude_category_ids: c.exclude_category_ids ?? [],
          include_product_ids: c.include_product_ids ?? [],
          exclude_product_ids: c.exclude_product_ids ?? [],
          max_discount_amount: c.max_discount_amount != null ? Number(c.max_discount_amount) : undefined,
          min_cart_amount: c.min_cart_amount != null ? Number(c.min_cart_amount) : undefined,
        };

        setForm(loaded);
      })
      .catch((e: any) => setError(`No se pudo cargar el cupón: ${e.message || e}`))
      .finally(() => setLoading(false));
  }, [couponId, storeId]);

  // ============ Handlers ============
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm((prev) => {
      if (name === "discount_value" || name === "max_discount_amount" || name === "min_cart_amount") {
        return { ...prev, [name]: value === "" ? undefined : Number(value) };
      }
      if (name === "valid_from" || name === "valid_until") {
        return { ...prev, [name]: fromInputDate(value) };
      }
      return { ...prev, [name]: value };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    // payload al backend
    const payload = {
      ...form,
      // Si tu backend necesita name, lo igualamos a code
      name: form.code,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
    };

    try {
      const url = `/api/campaigns${isEditing ? `/${encodeURIComponent(couponId as string)}` : ""}`;
      const method = isEditing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved(); // el padre refresca lista y cierra
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  // ============ UI ============
  if (loading) {
    return (
      <div className="max-w-3xl mx-auto mt-8 p-6 bg-white shadow rounded-xl">
        <div className="text-sm text-slate-600">Cargando cupón…</div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto mt-8 p-6 bg-white shadow rounded-xl">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={onClose}
          className="text-sm rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50"
        >
          ← Volver
        </button>
        <div className="text-sm text-slate-500">
          {isEditing ? `Editando cupón ${form.code || ""}` : "Creando nuevo cupón"}
        </div>
      </div>

      <h1 className="text-2xl font-bold mb-4">{isEditing ? "Editar cupón" : "Crear cupón"}</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Código (es el “nombre visible”) */}
        <div>
          <label className="block font-semibold">Código</label>
          <input
            type="text"
            name="code"
            value={form.code}
            onChange={handleChange}
            className="border p-2 rounded w-full"
            required
          />
        </div>

        {/* Tipo y valor */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold">Tipo de descuento</label>
            <select
              name="discount_type"
              value={form.discount_type}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            >
              <option value="percent">Porcentaje</option>
              <option value="absolute">Monto fijo</option>
            </select>
          </div>
          <div>
            <label className="block font-semibold">Valor del descuento</label>
            <input
              type="number"
              name="discount_value"
              value={form.discount_value}
              onChange={handleChange}
              className="border p-2 rounded w-full"
              required
            />
          </div>
        </div>

        {/* Vigencia */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold">Válido desde</label>
            <input
              type="date"
              name="valid_from"
              value={form.valid_from}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            />
          </div>
          <div>
            <label className="block font-semibold">Válido hasta</label>
            <input
              type="date"
              name="valid_until"
              value={form.valid_until}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            />
          </div>
        </div>

        {/* Reglas básicas */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold">Límite máximo de descuento ($)</label>
            <input
              type="number"
              name="max_discount_amount"
              value={form.max_discount_amount ?? ""}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            />
          </div>
          <div>
            <label className="block font-semibold">Monto mínimo de carrito ($)</label>
            <input
              type="number"
              name="min_cart_amount"
              value={form.min_cart_amount ?? ""}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            />
          </div>
        </div>

        {/* Alcance (placeholder – lo podemos extender) */}
        <div>
          <label className="block font-semibold">Alcance</label>
          <select
            name="apply_scope"
            value={form.apply_scope}
            onChange={handleChange}
            className="border p-2 rounded w-full"
          >
            <option value="all">Todos los productos</option>
            <option value="categories">Solo categorías (WIP)</option>
            <option value="products">Solo productos (WIP)</option>
          </select>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? "Guardando…" : isEditing ? "Guardar cambios" : "Crear cupón"}
          </button>
          {error && <span className="text-rose-600 text-sm ml-2">❌ {error}</span>}
        </div>
      </form>
    </div>
  );
}
