// Jonesco Art Dept. shop worker
//
// POST /checkout  form post from the site → creates a Stripe Checkout Session → 303 to Stripe's hosted page
// POST /webhook   Stripe event → once an order is paid, creates the matching order in Printful
//
// Secrets (wrangler secret put …): STRIPE_KEY, STRIPE_WEBHOOK_SECRET, PRINTFUL_TOKEN
// Vars (wrangler.toml): SITE_URL, PRINTFUL_STORE_ID, PRINTFUL_CONFIRM, STRIPE_PRICE_MUG

import Stripe from 'stripe';

// What the site sells through Stripe. The browser only sends the key ("mug");
// prices and Printful variants live here so they can't be changed client-side.
// Stripe price IDs differ between sandbox and live, so they come from wrangler.toml vars.
const catalog = env => ({
  mug: {
    price: env.STRIPE_PRICE_MUG,
    printfulSyncVariantId: 5529832854,         // Printful "Black Glossy Mug / 11 oz"
    maxQuantity: 10,
    returnPath: '/mug/'
  }
});

const SHIPPING = {
  display_name: 'Standard shipping (US)',
  type: 'fixed_amount',
  fixed_amount: { amount: 695, currency: 'usd' },
  delivery_estimate: {
    minimum: { unit: 'business_day', value: 5 },
    maximum: { unit: 'business_day', value: 10 }
  }
};

// Tags these sessions in the Stripe Dashboard so this checkout flow can be tracked on its own
const INTEGRATION_ID = 'artdept_hosted_checkout_qzkwhtmb';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/checkout') return checkout(request, env);
    if (request.method === 'POST' && url.pathname === '/webhook') return webhook(request, env);
    return new Response('Not found', { status: 404 });
  }
};

// Secrets piped in from a shell can carry a trailing newline, so trim them
const stripeClient = env => new Stripe(env.STRIPE_KEY.trim(), { httpClient: Stripe.createFetchHttpClient() });

async function checkout(request, env) {
  const form = await request.formData();
  const key = String(form.get('item') || '');
  const item = catalog(env)[key];
  if (!item) return new Response('Unknown item', { status: 400 });

  const stripe = stripeClient(env);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price: item.price,
      quantity: 1,
      adjustable_quantity: { enabled: true, minimum: 1, maximum: item.maxQuantity }
    }],
    shipping_address_collection: { allowed_countries: ['US'] },
    shipping_options: [{ shipping_rate_data: SHIPPING }],
    phone_number_collection: { enabled: true },  // carriers sometimes need it
    success_url: `${env.SITE_URL}/thanks/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}${item.returnPath}`,
    metadata: { item: key },
    integration_identifier: INTEGRATION_ID
  });

  return Response.redirect(session.url, 303);
}

async function webhook(request, env) {
  const stripe = stripeClient(env);
  const body = await request.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      request.headers.get('stripe-signature'),
      env.STRIPE_WEBHOOK_SECRET.trim(),
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    return new Response(`Bad signature: ${err.message}`, { status: 400 });
  }

  // Card payments arrive as completed+paid; delayed methods arrive later as async_payment_succeeded
  const fulfillable = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (!fulfillable.includes(event.type)) return new Response('Ignored', { status: 200 });

  const session = await stripe.checkout.sessions.retrieve(event.data.object.id, { expand: ['line_items'] });
  if (session.payment_status !== 'paid') return new Response('Not paid yet', { status: 200 });

  try {
    const result = await createPrintfulOrder(session, env);
    return new Response(result, { status: 200 });
  } catch (err) {
    // A non-2xx makes Stripe retry the event later
    console.error('Printful order failed', session.id, err.message);
    return new Response('Printful order failed', { status: 500 });
  }
}

async function createPrintfulOrder(session, env) {
  const ship = session.collected_information?.shipping_details || session.shipping_details;
  if (!ship?.address) throw new Error('No shipping address on session');

  const priceToItem = Object.fromEntries(Object.values(catalog(env)).map(i => [i.price, i]));
  const items = session.line_items.data.map(li => {
    const item = priceToItem[li.price.id];
    if (!item?.printfulSyncVariantId) throw new Error(`No Printful variant for price ${li.price.id}`);
    return {
      sync_variant_id: item.printfulSyncVariantId,
      quantity: li.quantity,
      retail_price: (li.price.unit_amount / 100).toFixed(2)
    };
  });

  const a = ship.address;
  const order = {
    // Printful rejects a second order with the same external_id, so Stripe retries can't double-ship.
    // Printful caps external_id at 32 characters; the PaymentIntent ID fits, the session ID doesn't.
    external_id: session.payment_intent,
    shipping: 'STANDARD',
    recipient: {
      name: ship.name,
      address1: a.line1,
      address2: a.line2 || undefined,
      city: a.city,
      state_code: a.state,
      country_code: a.country,
      zip: a.postal_code,
      email: session.customer_details?.email,
      phone: session.customer_details?.phone || undefined
    },
    items,
    retail_costs: {
      shipping: ((session.shipping_cost?.amount_total || 0) / 100).toFixed(2)
    }
  };

  // PRINTFUL_CONFIRM=true sends orders straight to production; anything else leaves them as drafts to approve
  const confirm = env.PRINTFUL_CONFIRM === 'true';
  const res = await fetch(`https://api.printful.com/orders?confirm=${confirm}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PRINTFUL_TOKEN.trim()}`,
      'X-PF-Store-Id': env.PRINTFUL_STORE_ID,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(order)
  });
  const data = await res.json().catch(() => ({}));

  if (res.ok) return `Printful order ${data.result?.id} created (${confirm ? 'confirmed' : 'draft'})`;
  // Already created on an earlier delivery of this event
  if (res.status === 400 && /external.?id/i.test(data.error?.message || data.result || '')) return 'Printful order already exists';
  throw new Error(`Printful ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
}
