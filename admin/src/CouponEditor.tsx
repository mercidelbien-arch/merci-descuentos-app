import { useState } from "react";

type CouponForm = {
  id?: string;
  store_id: string;
  code: string;
  name: string;
  discount_type: "percent" | "absolute";
  discount_value: number;
  valid_from: string;
  valid_until: string;
  apply_scope: "all" | "categories" | "products";
  include_category_ids?: number[];
  exclude_category_ids?: number[];
  include_product_ids?: number[];
  exclude_product_ids?: number[];
  max_discount_amount?: number;
  min_cart_amount?: number;
};

export default function CouponEditor({
  onClose,
  onSaved,
}: {
  onClose?: () => void;
  onSaved?: () => void;
}) {
  // tomar store_id de la URL si está
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );
  const storeIdFromUrl = params.get("store_id") ?? "";

  const [form, setForm] = useState<CouponForm>({
    store_id: storeIdFromUrl,
    code: "",
    name: "",
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

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;

    // numéricos
    const numericFields = new Set([
      "discount_value",
      "max_discount_amount",
      "min_cart_amount",
    ]);

    setForm((prev) => ({
      ...prev,
      [name]: numericFields.has(name) ? (value === "" ? undefined : Number(value)) : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      const res = await fetch("/api/campaigns", {
        method: form.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error(`Error HTTP ${res.status}`);
      setSuccess(true);
      onSaved?.(); // avisar arriba
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-8 p-6 bg-white shadow rounded-xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Crear / Editar cupón</h1>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
          >
            Cancelar
          </button>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

          <div>
            <label className="block font-semibold">Nombre</label>
            <input
              type="text"
              name="name"
              value={form.name}
              onChange={handleChange}
              className="border p-2 rounded w-full"
              required
            />
          </div>
        </div>

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
            <label className="block font-semibold">Valor</label>
            <input
              type="number"
              name="discount_value"
              value={form.discount_value}
              onChange={handleChange}
              className="border p-2 rounded w-full"
              required
            />
          </div>

          <div>
            <label className="block font-semibold">Store ID</label>
            <input
              type="text"
              name="store_id"
              value={form.store_id}
              onChange={handleChange}
              className="border p-2 rounded w-full"
              placeholder="ID de tienda (si no vino en la URL)"
            />
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block font-semibold">Válido desde</label>
            <input
              type="date"
              name="valid_from"
              value={form.valid_from}
              onChange={handleChange}
              className="border p-2 rounded w-full"
            />
          </div>
          <div className="flex-1">
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block font-semibold">Límite máximo de descuento ($)</label>
            <input
              type="number"
              name="max_discount_amount"
              value={form.max_discount_amount ?? ""}
              onChange={handleChange}
              className="border p-2 rounded w-full"
              min={0}
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
              min={0}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          {saving ? "Guardando..." : "Guardar cupón"}
        </button>

        {error && <p className="text-red-600 mt-2">❌ {error}</p>}
        {success && <p className="text-green-600 mt-2">✅ Cupón guardado correctamente</p>}
      </form>
    </div>
  );
}
