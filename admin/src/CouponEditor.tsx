import { useEffect, useMemo, useState } from "react";

type CouponForm = {
  id?: string;
  store_id: string;
  // “code” será también el nombre que guardamos en la API
  code: string;
  // name se completa con code al guardar (no se edita en UI)
  name?: string;
  discount_type: "percent" | "absolute";
  discount_value: number;
  valid_from: string;
  valid_until: string;
  apply_scope: "all" | "categories" | "products";
  include_category_ids?: number[];
  exclude_category_ids?: number[];
  include_product_ids?: number[];
  exclude_product_ids?: number[];
  max_discount_amount?: number | null;
  min_cart_amount?: number | null;
};

function parseIds(s: string): number[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => !Number.isNaN(n));
}

export default function CouponEditor({
  storeId,
  couponId,
  onClose,
  onSaved,
}: {
  storeId: string;
  couponId?: string | null; // null/new -> crear, id -> editar
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!couponId && couponId !== "new";

  const [form, setForm] = useState<CouponForm>({
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
    max_discount_amount: null,
    min_cart_amount: null,
  });

  const [raw, setRaw] = useState({
    include_category_ids: "",
    exclude_category_ids: "",
    include_product_ids: "",
    exclude_product_ids: "",
  });

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Cargar datos si es edición
  useEffect(() => {
    let abort = false;
    const load = async () => {
      if (!isEdit) return;
      try {
        setLoading(true);
        const r = await fetch(`/api/campaigns/${couponId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        if (abort) return;

        const f: CouponForm = {
          id: String(data.id),
          store_id: String(data.store_id ?? storeId),
          code: data.code ?? "",
          discount_type: data.discount_type ?? "percent",
          discount_value: Number(data.discount_value ?? 10),
          valid_from: data.valid_from ? data.valid_from.slice(0, 10) : "",
          valid_until: data.valid_until ? data.valid_until.slice(0, 10) : "",
          apply_scope: (data.apply_scope as CouponForm["apply_scope"]) ?? "all",
          include_category_ids: (data.include_category_ids ?? []) as number[],
          exclude_category_ids: (data.exclude_category_ids ?? []) as number[],
          include_product_ids: (data.include_product_ids ?? []) as number[],
          exclude_product_ids: (data.exclude_product_ids ?? []) as number[],
          max_discount_amount:
            data.max_discount_amount == null ? null : Number(data.max_discount_amount),
          min_cart_amount:
            data.min_cart_amount == null ? null : Number(data.min_cart_amount),
        };

        setForm(f);
        setRaw({
          include_category_ids: (f.include_category_ids ?? []).join(", "),
          exclude_category_ids: (f.exclude_category_ids ?? []).join(", "),
          include_product_ids: (f.include_product_ids ?? []).join(", "),
          exclude_product_ids: (f.exclude_product_ids ?? []).join(", "),
        });
      } catch (e: any) {
        setError(e.message || String(e));
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => {
      abort = true;
    };
  }, [couponId, isEdit, storeId]);

  const title = useMemo(
    () => (isEdit ? `Editar cupón` : `Crear cupón`),
    [isEdit]
  );

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]:
        name === "discount_value" ||
        name === "max_discount_amount" ||
        name === "min_cart_amount"
          ? (value === "" ? null : Number(value))
          : value,
    }));
  };

  const handleRawChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setRaw((r) => ({ ...r, [name]: value }));
  };

  const syncParsedLists = (draft: CouponForm): CouponForm => {
    return {
      ...draft,
      include_category_ids: parseIds(raw.include_category_ids),
      exclude_category_ids: parseIds(raw.exclude_category_ids),
      include_product_ids: parseIds(raw.include_product_ids),
      exclude_product_ids: parseIds(raw.exclude_product_ids),
    };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const payload = syncParsedLists({
        ...form,
        // “name” se persiste igual a code para evitar confusión
        name: form.code,
      });

      const res = await fetch(isEdit ? `/api/campaigns/${couponId}` : `/api/campaigns`, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
      setSuccess(true);
      onSaved(); // refresca la lista y cierra
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto mt-4">
      <div className="mb-4 flex items-center justify-between">
        <button
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
        >
          ← Volver a cupones
        </button>
        <div className="text-sm text-slate-500">
          {isEdit ? `Editando cupón #${couponId}` : `Creando nuevo cupón`}
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-bold mb-2">{title}</h1>
        {loading ? (
          <div className="text-sm text-slate-500">Cargando…</div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Código - actúa como “nombre” del cupón */}
            <div>
              <label className="block font-semibold">Código (usado como nombre)</label>
              <input
                type="text"
                name="code"
                value={form.code}
                onChange={handleChange}
                className="border p-2 rounded w-full"
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                Este valor también se guarda como <code>name</code>.
              </p>
            </div>

            {/* Tipo y valor */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                <label className="block font-semibold">
                  Valor del descuento {form.discount_type === "percent" ? "(%)" : "($)"}
                </label>
                <input
                  type="number"
                  name="discount_value"
                  value={Number(form.discount_value ?? 0)}
                  onChange={handleChange}
                  className="border p-2 rounded w-full"
                  required
                />
              </div>
              <div>
                <label className="block font-semibold">Ámbito de aplicación</label>
                <select
                  name="apply_scope"
                  value={form.apply_scope}
                  onChange={handleChange}
                  className="border p-2 rounded w-full"
                >
                  <option value="all">Todo el catálogo</option>
                  <option value="categories">Sólo categorías</option>
                  <option value="products">Sólo productos</option>
                </select>
              </div>
            </div>

            {/* Fechas */}
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

            {/* Reglas / Topes */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold">
                  Límite máximo de descuento ($)
                </label>
                <input
                  type="number"
                  name="max_discount_amount"
                  value={form.max_discount_amount ?? ""}
                  onChange={handleChange}
                  className="border p-2 rounded w-full"
                  placeholder="Opcional"
                />
              </div>
              <div>
                <label className="block font-semibold">Mínimo de carrito ($)</label>
                <input
                  type="number"
                  name="min_cart_amount"
                  value={form.min_cart_amount ?? ""}
                  onChange={handleChange}
                  className="border p-2 rounded w-full"
                  placeholder="Opcional"
                />
              </div>
            </div>

            {/* Include/Exclude lists */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold">
                  Incluir categorías (IDs, separados por coma)
                </label>
                <input
                  type="text"
                  name="include_category_ids"
                  value={raw.include_category_ids}
                  onChange={handleRawChange}
                  className="border p-2 rounded w-full"
                  placeholder="12, 34, 56"
                />
              </div>
              <div>
                <label className="block font-semibold">
                  Excluir categorías (IDs, separados por coma)
                </label>
                <input
                  type="text"
                  name="exclude_category_ids"
                  value={raw.exclude_category_ids}
                  onChange={handleRawChange}
                  className="border p-2 rounded w-full"
                  placeholder="78, 90"
                />
              </div>
              <div>
                <label className="block font-semibold">
                  Incluir productos (IDs, separados por coma)
                </label>
                <input
                  type="text"
                  name="include_product_ids"
                  value={raw.include_product_ids}
                  onChange={handleRawChange}
                  className="border p-2 rounded w-full"
                  placeholder="101, 202"
                />
              </div>
              <div>
                <label className="block font-semibold">
                  Excluir productos (IDs, separados por coma)
                </label>
                <input
                  type="text"
                  name="exclude_product_ids"
                  value={raw.exclude_product_ids}
                  onChange={handleRawChange}
                  className="border p-2 rounded w-full"
                  placeholder="303, 404"
                />
              </div>
            </div>

            {/* Botones */}
            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {saving ? "Guardando…" : "Guardar cupón"}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>

            {error && <p className="text-rose-600">❌ {error}</p>}
            {success && <p className="text-emerald-600">✅ Guardado ok</p>}
          </form>
        )}
      </div>
    </div>
  );
}
