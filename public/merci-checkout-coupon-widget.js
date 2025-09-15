/* ============================================================================
 * Merci Descuentos – Checkout Coupon Widget (onload, auto-instalado)
 * Versión: 1.0.0
 * Objetivo: Mostrar/aplicar 1 sola línea de descuento (nuestro engine).
 * Requisitos: publicar este JS y cargarlo en Checkout.
 * ========================================================================== */

(function () {
  "use strict";
function getCheckoutId() {
  try {
    if (window.__PRELOADED_STATE__?.checkout?.id) return String(window.__PRELOADED_STATE__.checkout.id);
    if (window.checkout?.id) return String(window.checkout.id);
    var parts = location.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
  } catch { return 'unknown'; }
}

  
  /* ========= CONFIGURACIÓN BÁSICA (AJUSTAR) ================================ */
  // 🔧 Reemplazá por tu URL pública de Render (sin / al final)
  // Ej: "https://merci-descuentos.onrender.com"
  const API_BASE = "https://merci-descuentos-app.onrender.com";

  // Endpoint que valida/aplica cupones. Debe devolver: { ok, code, amount, label }
  // - amount: número NEGATIVO si es descuento (ej: -123.45)
  // - label: texto a mostrar en la línea de descuento (ej: "Cupón MERCI-10")
  const APPLY_ENDPOINT = "/api/checkout/code/set";

  // Identificador único de la línea de descuento que inyecta el widget
  const DISCOUNT_LINE_ID = "merci-discount-line";

  // Selectores del DOM del checkout (ajústalos si tu theme/checkout difiere)
  const SELECTORS = {
    orderSummary: '[data-testid="order-summary"], .order-summary, #order-summary',
    totalsList: '.summary-totals, [data-testid="summary-totals"], .checkout-summary-totals',
    discountRow: `.${DISCOUNT_LINE_ID}`,
    couponInputHost: '#merci-coupon-input-host', // contenedor propio (lo inyectamos)
  };

  // Mensajes UI
  const MESSAGES = {
    apply: "Aplicar",
    placeholder: "Ingresá tu código",
    invalid: "Código inválido o no aplicable",
    loading: "Validando...",
  };

  /* ========= UTILIDADES ==================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function onReady(fn) {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      fn();
    } else {
      document.addEventListener("DOMContentLoaded", fn);
    }
  }

  function qs(sel, root = document) {
    return root.querySelector(sel);
  }

  function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function waitFor(selector, { timeout = 10000, interval = 100 } = {}) {
    return new Promise(async (resolve, reject) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const el = qs(selector);
        if (el) return resolve(el);
        await sleep(interval);
      }
      reject(new Error(`Timeout esperando selector: ${selector}`));
    });
  }

  function formatCurrency(amount) {
    try {
      return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `$ ${amount.toFixed(2)}`;
    }
  }

  function parseCartFromDOM() {
    const items = [];
    qsa('[data-testid="line-item"], .line-item').forEach((row) => {
      const name = row.querySelector('[data-testid="line-item-name"], .line-item__title')?.textContent?.trim() || "Item";
      const qtyTxt = row.querySelector('[data-testid="line-item-qty"], .line-item__qty')?.textContent || "1";
      const qty = Number(qtyTxt.replace(/[^\d]/g, "")) || 1;
      const priceTxt = row.querySelector('[data-testid="line-item-price"], .line-item__price')?.textContent || "0";
      const price = Number(priceTxt.replace(/[^\d,.-]/g, "").replace(".", "").replace(",", ".")) || 0;
      items.push({ name, qty, price });
    });

    let subtotal = 0;
    items.forEach((it) => (subtotal += it.price * it.qty));

    return { items, subtotal };
  }

  function removeExistingNonMerciDiscountLines() {
    // Remueve líneas de "Cupón/Código/Descuento" que no sean las del widget
    const rows = qsa(`${SELECTORS.totalsList} .summary-row, ${SELECTORS.totalsList} li, .totals .row`);
    rows.forEach((row) => {
      const isOurs = row.classList?.contains(DISCOUNT_LINE_ID);
      if (isOurs) return;
      const txt = row.textContent?.toLowerCase() || "";
      const looksLikeCoupon = /(cup[oó]n|descuento|c[oó]digo)/.test(txt);
      const looksLikeShippingOrTax = /(env[ií]o|flete|impuesto|iva|tax|shipping)/.test(txt);
      if (looksLikeCoupon && !looksLikeShippingOrTax) {
        row.remove();
      }
    });
  }

  function renderDiscountRow({ label, amount }) {
    const totals = qs(SELECTORS.totalsList);
    if (!totals) return;

    // Quitar la previa nuestra si existe
    qsa(SELECTORS.discountRow).forEach((n) => n.remove());

    const row = document.createElement("div");
    row.className = `summary-row ${DISCOUNT_LINE_ID}`;
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const left = document.createElement("span");
    left.textContent = label || "Descuento Merci";
    left.setAttribute("aria-label", "Línea de descuento Merci");

    const right = document.createElement("strong");
    right.textContent = formatCurrency(amount);
    right.style.whiteSpace = "nowrap";

    row.appendChild(left);
    row.appendChild(right);

    totals.prepend(row); // arriba del total
  }

  function ensureCouponInput(orderSummaryEl) {
    if (qs(SELECTORS.couponInputHost)) return;

    const host = document.createElement("div");
    host.id = "merci-coupon-input-host";
    host.style.display = "grid";
    host.style.gridTemplateColumns = "1fr auto";
    host.style.gap = "8px";
    host.style.margin = "12px 0";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = MESSAGES.placeholder;
    input.autocomplete = "off";
    input.inputMode = "text";
    input.style.padding = "10px 12px";
    input.style.border = "1px solid #d1d5db";
    input.style.borderRadius = "10px";
    input.style.outline = "none";
    input.style.fontSize = "14px";
    input.setAttribute("aria-label", "Código de descuento Merci");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = MESSAGES.apply;
    btn.style.padding = "10px 14px";
    btn.style.borderRadius = "10px";
    btn.style.border = "0";
    btn.style.cursor = "pointer";
    btn.style.fontWeight = "600";
    btn.style.background = "#111827";
    btn.style.color = "#fff";

    const msg = document.createElement("div");
    msg.style.fontSize = "12px";
    msg.style.marginTop = "6px";
    msg.style.minHeight = "16px";
    msg.style.color = "#b91c1c"; // rojo para error

    host.appendChild(input);
    host.appendChild(btn);
    orderSummaryEl.prepend(host);
    orderSummaryEl.appendChild(msg);

    btn.addEventListener("click", async () => {
      const code = (input.value || "").trim();
      msg.style.color = "#6b7280";
      msg.textContent = MESSAGES.loading;

      const { items, subtotal } = parseCartFromDOM();

      try {
        const res = await fetch(`${API_BASE}${APPLY_ENDPOINT}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkout_id: getCheckoutId(), code }),
          credentials: "omit",
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (!data?.ok || !data?.amount) {
          msg.style.color = "#b91c1c";
          msg.textContent = MESSAGES.invalid;
          qsa(SELECTORS.discountRow).forEach((n) => n.remove());
          return;
        }

        removeExistingNonMerciDiscountLines();

        renderDiscountRow({
          label: data.label || `Descuento (${data.code || code})`,
          amount: Number(data.amount), // negativo
        });

        msg.style.color = "#065f46";
        msg.textContent = "Descuento aplicado.";
      } catch (err) {
        msg.style.color = "#b91c1c";
        msg.textContent = "Error de conexión. Probá nuevamente.";
        console.error("Merci widget error:", err);
      }
    });
  }

  function bootstrap() {
    const init = async () => {
      try {
        const summary = await waitFor(SELECTORS.orderSummary, { timeout: 10000 });
        ensureCouponInput(summary);
        removeExistingNonMerciDiscountLines();
      } catch {
        return;
      }
    };

    init();

    const mo = new MutationObserver(() => {
      const summary = qs(SELECTORS.orderSummary);
      if (summary && !qs(SELECTORS.couponInputHost)) {
        ensureCouponInput(summary);
      }
      removeExistingNonMerciDiscountLines();
    });
    mo.observe(document.documentElement, { subtree: true, childList: true });
  }

  onReady(bootstrap);
})();
