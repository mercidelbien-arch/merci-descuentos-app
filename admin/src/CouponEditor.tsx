import React, { useEffect, useMemo, useState } from "react";

/** ====== Tipos ====== */
type CouponForm = {
  id?: string;
  store_id: string;
  code: string;
  name: string;
  discount_type: "percent" | "absolute";
  discount_value: number;
  valid_from?: string | null;
  valid_until?: string | null;
  min_cart_amount?: number;
  max_discount_amount?: number | null;
  monthly_cap_amount?: number | null;
  exclude_sale_items?: boolean;

  // alcance
  apply_scope: "all" | "categories" | "products";
  include_category_ids: number[];
  exclude_category_ids: number[];
  include_product_ids: number[];
  exclude_product_ids: number[];
};

type Category = { id: number; name: string };
type Product = { id: number; name: string };

/** ====== Helpers minimos ====== */
async function apiJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
  if (!r.ok) throw new Error(`${init?.method || "GET"} ${url} → ${r.status}`);
  return r.json();
}
const toInt = (v: any, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);

/** ====== Editor ====== */
export default function CouponEditor({
  storeId,
  initial,             // si viene id => edición; si no => creación
  onCancel,
  onSaved,
}: {
  storeId: string;
  initial?: Partial<CouponForm>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!initial?.id;

  const [values, setValues] = useState<CouponForm>({
    id: initial?.id,
    store_id: storeId,
    code: initial?.code || "",
    name: initial?.name || "",
    discount_type: (initial?.discount_type as any) || "percent",
    discount_value: toInt(initial?.discount_value, 0),
    valid_from: initial?.valid_from || null,
    valid_until: initial?.valid_until || null,
    min_cart_amount: toInt(initial?.min_cart_amount, 0),
    max_discount_amount:
      initial?.max_discount_amount === null || initial?.max_discount_amount === undefined
        ? null
        : toInt(initial?.max_discount_amount),
    monthly_cap_amount:
      initial?.monthly_cap_amount === null || initial?.monthly_cap_amount === undefined
        ? null
        : toInt(initial?.monthly_cap_amount),
    exclude_sale_items: !!initial?.exclude_sale_items,

    apply_scope: (initial?.apply_scope as any) || "all",
    include_category_ids: (initial?.include_category_ids as any) || [],
    exclude_category_ids: (initial?.exclude_category_ids as any) || [],
    include_product_ids: (initial?.include_product_ids as any) || [],
    exclude_product_ids: (initial?.exclude_product_ids as any) || [],
  });

  const set = (k: keyof CouponForm, v: any) => setValues(s => ({ ...s, [k]: v }));

  /** ====== Data para selects ====== */
  const [cats, setCats] = useState<Category[]>([]);
  const [prodQuery, setProdQuery] = useState("");
  const [prodResults, setProdResults] = useState<Product[]>([]);
  const canSearchProd = prodQuery.trim().length >= 2;

  useEffect(() => {
    // categorías
    apiJSON<Category[]>(`/api/tn/categories?store_id=${encodeURIComponent(storeId)}`)
      .then(setCats)
      .catch(() => setCats([]));
  }, [storeId]);

  useEffect(() => {
    let cancel = false;
    if (!canSearchProd) { setProdResults([]); return; }
    apiJSON<Product[]>(`/api/tn/products/search?store_id=${encodeURIComponent(storeId)}&q=${encodeURIComponent(prodQuery)}`)
      .then((r) => !cancel && setProdResults(r))
      .catch(() => !cancel && setProdResults([]));
    return () => { cancel = true; };
  }, [storeId, prodQuery, canSearchProd]);

  /** ====== Guardar ====== */
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSaving(true);
      const body = {
        store_id: values.store_id,
        code: values.code.trim(),
        name: values.name.trim(),
        discount_type: values.discount_type,
        discount_value: Number(values.discount_value),
        valid_from: values.valid_from || null,
        valid_until: values.valid_until || null,
        apply_scope: values.apply_scope,
        min_cart_amount: Number(values.min_cart_amount || 0),
        max_discount_amount: values.max_discount_amount === null ? null : Number(values.max_discount_amount),
        monthly_cap_amount: values.monthly_cap_amount === null ? null : Number(values.monthly_cap_amount),
        exclude_sale_items: !!values.exclude_sale_items,
        include_category_ids: values.include_category_ids,
        exclude_category_ids: values.exclude_category_ids,
        include_product_ids:  values.include_product_ids,
        exclude_product_ids:  values.exclude_product_ids,
      };

      if (isEdit && values.id) {
        await apiJSON(`/api/campaigns/${values.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiJSON(`/api/campaigns`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      onSaved();
    } catch (err: any) {
      alert(`Error al guardar: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  };

  /** ====== UI ====== */
  const scopeIs = (s: CouponForm["apply_scope"]) => values.apply_scope === s;

  return (
    <form onSubmit={submit} className="space-y-6">
      {/* Código */}
      {!isEdit && (
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Código del cupón</div>
          <input
            className="w-full rounded-xl border px-3 py-2 font-mono"
            placeholder="EJ: INVIERNO10"
            value={values.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
            required
          />
          <div className="mt-1 text-xs text-slate-500">El cliente lo ingresa en el checkout.</div>
        </div>
      )}

      {/* Nombre */}
      <div>
        <div className="text-sm font-medium text-slate-700 mb-1">Nombre interno</div>
        <input
          className="w-full rounded-xl border px-3 py-2"
          value={values.name}
          onChange={(e) => set("name", e.target.value)}
          required
        />
      </div>

      {/* Tipo de descuento */}
      <div>
        <div className="text-sm font-medium text-slate-700 mb-2">Tipo de descuento</div>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={values.discount_type === "percent"}
              onChange={() => set("discount_type", "percent")}
            />
            <span>Porcentaje</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={values.discount_type === "absolute"}
              onChange={() => set("discount_type", "absolute")}
            />
            <span>Monto fijo</span>
          </label>
          <input
            className="ml-4 w-40 rounded-xl border px-3 py-2"
            type="number"
            min={0}
            value={values.discount_value}
            onChange={(e) => set("discount_value", toInt(e.target.value, 0))}
          />
          <span className="text-sm text-slate-500">
            {values.discount_type === "percent" ? "%" : "ARS"}
          </span>
        </div>
      </div>

      {/* Vigencia */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Desde</div>
          <input
            className="w-full rounded-xl border px-3 py-2"
            type="date"
            value={values.valid_from || ""}
            onChange={(e) => set("valid_from", e.target.value || null)}
          />
        </div>
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Hasta</div>
          <input
            className="w-full rounded-xl border px-3 py-2"
            type="date"
            value={values.valid_until || ""}
            onChange={(e) => set("valid_until", e.target.value || null)}
          />
        </div>
      </div>

      {/* Reglas monetarias */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Mínimo de carrito</div>
          <input
            className="w-full rounded-xl border px-3 py-2"
            type="number"
            min={0}
            value={values.min_cart_amount || 0}
            onChange={(e) => set("min_cart_amount", toInt(e.target.value, 0))}
          />
        </div>
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Tope máximo de descuento</div>
          <input
            className="w-full rounded-xl border px-3 py-2"
            type="number"
            min={0}
            value={values.max_discount_amount ?? ""}
            placeholder="ej: 2000"
            onChange={(e) =>
              set("max_discount_amount", e.target.value === "" ? null : toInt(e.target.value, 0))
            }
          />
        </div>
        <div>
          <div className="text-sm font-medium text-slate-700 mb-1">Tope mensual (opcional)</div>
          <input
            className="w-full rounded-xl border px-3 py-2"
            type="number"
            min={0}
            value={values.monthly_cap_amount ?? ""}
            placeholder="ej: 150000"
            onChange={(e) =>
              set("monthly_cap_amount", e.target.value === "" ? null : toInt(e.target.value, 0))
            }
          />
        </div>
      </div>

      {/* Alcance */}
      <div>
        <div className="text-sm font-medium text-slate-700 mb-2">Aplicar a</div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={scopeIs("all")}
              onChange={() => set("apply_scope", "all")}
            />
            <span>Todos los productos</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={scopeIs("categories")}
              onChange={() => set("apply_scope", "categories")}
            />
            <span>Por categorías</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={scopeIs("products")}
              onChange={() => set("apply_scope", "products")}
            />
            <span>Por productos</span>
          </label>
        </div>

        {/* Categorías */}
        {scopeIs("categories") && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <div className="text-sm text-slate-600 mb-1">Incluir categorías</div>
              <select
                multiple
                value={values.include_category_ids.map(String)}
                onChange={(e) =>
                  set(
                    "include_category_ids",
                    Array.from(e.target.selectedOptions).map((o) => Number(o.value))
                  )
                }
                className="w-full rounded-xl border px-3 py-2 h-40"
              >
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <div className="text-sm text-slate-600 mb-1">Excluir categorías</div>
              <select
                multiple
                value={values.exclude_category_ids.map(String)}
                onChange={(e) =>
                  set(
                    "exclude_category_ids",
                    Array.from(e.target.selectedOptions).map((o) => Number(o.value))
                  )
                }
                className="w-full rounded-xl border px-3 py-2 h-40"
              >
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Productos */}
        {scopeIs("products") && (
          <div className="mt-3">
            <div className="text-sm text-slate-600 mb-1">Buscar productos (mín. 2 letras)</div>
            <input
              className="w-full rounded-xl border px-3 py-2"
              placeholder="Ej.: barrita, mix, bebida…"
              value={prodQuery}
              onChange={(e) => setProdQuery(e.target.value)}
            />
            {canSearchProd && (
              <div className="mt-2 rounded-xl border bg-white p-2 max-h-48 overflow-auto">
                {prodResults.length === 0 ? (
                  <div className="text-sm text-slate-500 px-2 py-1">Sin resultados…</div>
                ) : (
                  prodResults.map((p) => (
                    <div key={p.id} className="flex items-center justify-between px-2 py-1">
                      <div className="truncate">{p.name}</div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-2 py-1 text-xs"
                          onClick={() =>
                            set("include_product_ids", Array.from(new Set([...values.include_product_ids, p.id])))
                          }
                        >
                          Incluir
                        </button>
                        <button
                          type="button"
                          className="rounded-md border px-2 py-1 text-xs"
                          onClick={() =>
                            set("exclude_product_ids", Array.from(new Set([...values.exclude_product_ids, p.id])))
                          }
                        >
                          Excluir
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="text-sm font-medium text-slate-700 mb-1">Incluidos</div>
                <TagList
                  ids={values.include_product_ids}
                  onRemove={(id) => set("include_product_ids", values.include_product_ids.filter(x => x !== id))}
                />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-700 mb-1">Excluidos</div>
                <TagList
                  ids={values.exclude_product_ids}
                  onRemove={(id) => set("exclude_product_ids", values.exclude_product_ids.filter(x => x !== id))}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Acciones */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" onClick={onCancel} className="rounded-xl border bg-white px-4 py-2">
          Cancelar
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {isEdit ? "Guardar cambios" : "Crear cupón"}
        </button>
      </div>
    </form>
  );
}

/** Etiquetas simples para ids de productos */
function TagList({ ids, onRemove }: { ids: number[]; onRemove: (id: number) => void }) {
  if (ids.length === 0) return <div className="text-sm text-slate-500">Vacío</div>;
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <span key={id} className="inline-flex items-center gap-2 rounded-full border bg-slate-50 px-3 py-1 text-xs">
          #{id}
          <button className="text-slate-500 hover:text-rose-600" onClick={() => onRemove(id)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
