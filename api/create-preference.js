import { MercadoPagoConfig, Preference } from "mercadopago";
import { sbRequest } from "../lib/supabase.js";
import fs from "fs";
import path from "path";

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function loadLocalCatalog() {
  try {
    const filePath = path.join(process.cwd(), "data", "products.json");
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function normalizeCartItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(it => ({
    sku: String(it.sku),
    quantity: Math.max(1, parseInt(it.qty ?? it.quantity ?? 1, 10)),
    variantId: it.variantId ?? it.variant ?? null
  }));
}

export async function POST(request) {
  try {
    const token = process.env.MP_ACCESS_TOKEN;
    if (!token) return json(500, { error: "Missing MP_ACCESS_TOKEN" });

    const body = await request.json();
    const cartItems = normalizeCartItems(body.items);
    const shipping = body.shipping || {};

    if (!cartItems.length) return json(400, { error: "Cart empty" });
    if (!shipping.name || !shipping.email)
      return json(400, { error: "Missing shipping data" });

    const catalog = loadLocalCatalog();

    const mpItems = [];
    let totalCents = 0;

    for (const it of cartItems) {
      const product = catalog.find(p => p.sku === it.sku);
      if (!product) return json(400, { error: `Produto não encontrado: ${it.sku}` });

      let priceCents = product.price_cents;

      if (!priceCents && product.price) {
        const match = product.price.match(/\d+,\d+/);
        if (match) {
          priceCents = Math.round(parseFloat(match[0].replace(",", ".")) * 100);
        }
      }

      if (!priceCents)
        return json(400, { error: `Invalid price for ${product.sku}` });

      totalCents += priceCents * it.quantity;

      mpItems.push({
        title: product.name,
        quantity: it.quantity,
        unit_price: priceCents / 100,
        currency_id: "BRL"
      });
    }

const externalRef = "CB-" + Date.now();

    // ✅ STORE ORDER IN SUPABASE
    await sbRequest("orders", {
      method: "POST",
      body: {
        external_reference: externalRef,
        status: "created",
        total_cents: totalCents,
        items: {
          cart: cartItems,
          shipping
        }
      }
    });

    const client = new MercadoPagoConfig({ accessToken: token });
    const preference = new Preference(client);

const pref = await preference.create({
  body: {
    items: mpItems,
    external_reference: externalRef,
    back_urls: {
      success: "https://cristalbags.vercel.app/success.html",
      failure: "https://cristalbags.vercel.app/failure.html",
      pending: "https://cristalbags.vercel.app/pending.html"
    },
    auto_return: "approved"
  }
});
    return json(200, { checkout_url: pref.init_point });

  } catch (err) {
    console.error(err);
    return json(500, { error: "Internal error" });
  }
}
