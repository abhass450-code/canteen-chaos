// smoke.js - end-to-end checks against a running server.
//   node smoke.js            (server must be up on :3000)
//   BASE=http://host node smoke.js
//
// Uses the server's own clock, so it works whatever time of day it is.
// Every planted bug should make at least one of these fail.

const BASE = process.env.BASE || 'http://localhost:3000';
const MEMBER = 'smoke-' + Math.random().toString(36).slice(2, 8);
const IDEM = 'smoke-key-' + Math.random().toString(36).slice(2, 10);
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function call(path, options = {}) {
  const res = await fetch(BASE + path, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Member-Id': options.member || MEMBER,
      ...(options.idem ? { 'Idempotency-Key': options.idem } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  let json = null;
  try {
    json = await res.json();
  } catch (e) {
    /* some responses have no body */
  }

  return { status: res.status, json, headers: res.headers };
}

const near = (a, b, tolerance = 0.02) => Math.abs(a - b) < tolerance;

(async () => {
  console.log('Canteen Chaos smoke test');

  /* ------------------------------------------------------- health */
  section('health');
  const health = await call('/api/health');
  check('health responds', health.status === 200 && health.json.status === 'ok');
  check('health reports a slot', 'slot' in health.json);
  check('request id header present', Boolean(health.headers.get('X-Request-Id')));
  console.log(`       slot=${health.json.slot} open=${health.json.open} rush=${health.json.rushHour}`);

  /* --------------------------------------------------------- menu */
  section('menu');
  const menu = await call('/api/menu?limit=48');
  check('menu returns dishes', menu.json.dishes.length > 0);
  check('menu reports totals', menu.json.total >= menu.json.dishes.length);
  check('dishes carry availability', 'orderable' in menu.json.dishes[0]);

  const page1 = await call('/api/menu?limit=5&page=1');
  const page2 = await call('/api/menu?limit=5&page=2');
  check('pages differ', page1.json.dishes[0].id !== page2.json.dishes[0].id);
  check('page count is right', page1.json.pages === Math.ceil(page1.json.total / 5));

  const sorted = await call('/api/menu?sort=price-asc&limit=48');
  const prices = sorted.json.dishes.map((d) => d.price);
  check('sort by price works', prices.every((p, i) => i === 0 || prices[i - 1] <= p));

  const byName = await call('/api/menu?sort=name-asc&limit=48');
  const names = byName.json.dishes.map((d) => d.name);
  check('sort by name works', names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0));

  const veg = await call('/api/menu?veg=true&limit=48');
  check('veg filter works', veg.json.dishes.every((d) => d.veg === true));

  const cheap = await call('/api/menu?maxPrice=40&limit=48');
  check('price filter works', cheap.json.dishes.every((d) => d.price <= 40));

  /* ------------------------------------------------------- search */
  section('search');
  const search = await call('/api/menu?q=momos');
  check('search finds momos', search.json.dishes.length > 0 && /momo/i.test(search.json.dishes[0].name));

  const twoWords = await call('/api/menu?q=chicken%20momos');
  check('every term must match', twoWords.json.dishes.every((d) => /chicken/i.test(d.name)));

  const nonsense = await call('/api/menu?q=zzzzqqq');
  check('nonsense returns nothing', nonsense.json.dishes.length === 0);

  const suggest = await call('/api/menu/suggest?q=cof');
  check('suggestions work', suggest.json.suggestions.length > 0);
  check('suggestions are capped', suggest.json.suggestions.length <= 6);

  const cats = await call('/api/menu/categories');
  check('categories listed', cats.json.categories.length === 5);
  check('categories have counts', cats.json.categories.every((c) => c.count > 0));

  check('picks returned', (await call('/api/menu/picks')).json.picks.length > 0);
  check('404 on unknown dish', (await call('/api/menu/9999')).status === 404);
  check('404 on unknown route', (await call('/api/nope')).status === 404);

  /* ------------------------------------------------ dish detail */
  const first = menu.json.dishes[0];
  const detail = await call(`/api/menu/${first.id}`);
  check('dish detail has breakdown', 'ratingBreakdown' in detail.json);
  check('dish detail has suggestions', Array.isArray(detail.json.alsoBought));

  /* ------------------------------------------------------ pricing */
  section('pricing');
  const orderable = menu.json.dishes.find((d) => d.orderable);

  if (!orderable) {
    console.log('\n  (canteen closed for this slot - skipping order tests)');
  } else {
    const quote = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 2 }] },
    });

    const expectedSub = Math.round((orderable.price * 2 + Number.EPSILON) * 100) / 100;
    check('subtotal is right', near(quote.json.subtotal, expectedSub), `${quote.json.subtotal} vs ${expectedSub}`);
    check('packing is Rs. 5 per item', quote.json.packing === 10);
    check('gst is 5% of taxable', near(quote.json.gst, (quote.json.foodTotal + quote.json.packing + quote.json.rushSurcharge) * 0.05));
    check('total adds up', near(quote.json.total, quote.json.foodTotal + quote.json.packing + quote.json.rushSurcharge + quote.json.gst + quote.json.tip));

    const bulk = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 10 }] },
    });
    check('packing is capped at Rs. 20', bulk.json.packing === 20);

    const tipped = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 2 }], tipPercent: 10 },
    });
    check('percentage tip works', near(tipped.json.tip, tipped.json.foodTotal * 0.1));

    const badTip = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], tipPercent: 73 },
    });
    check('odd tip percent ignored', badTip.json.tip === 0);

    const hugeTip = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], tipFlat: 5000 },
    });
    check('flat tip is capped', hugeTip.json.tip === 100);

    /* ----------------------------------------------------- coupons */
    section('coupons');
    const expired = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], couponCode: 'FRESHERS24' },
    });
    check('expired coupon refused', expired.json.couponDiscount === 0 && !!expired.json.couponError);

    const unknown = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], couponCode: 'NOPE99' },
    });
    check('unknown coupon refused', unknown.json.couponError === 'Coupon not found');

    const small = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], couponCode: 'FLAT50' },
    });
    check('minimum order enforced', small.json.couponDiscount === 0 || small.json.subtotal >= 250);

    const big = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 8 }], couponCode: 'BYTE10' },
    });
    if (big.json.couponDiscount > 0) {
      check('percent coupon is capped', big.json.couponDiscount <= 40, `${big.json.couponDiscount}`);
    } else {
      check('percent coupon is capped', true);
    }

    const coupons = await call('/api/coupons');
    check('only usable coupons listed', coupons.json.coupons.every((c) => c.code !== 'FRESHERS24'));

    /* -------------------------------------------------- validation */
    section('validation');
    const bad = (body) => call('/api/orders', { method: 'POST', body });

    check('negative qty rejected', (await bad({ items: [{ dishId: orderable.id, qty: -5 }] })).status === 400);
    check('fractional qty rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1.5 }] })).status === 400);
    check('string qty rejected', (await bad({ items: [{ dishId: orderable.id, qty: '2' }] })).status === 400);
    check('junk dishId rejected', (await bad({ items: [{ dishId: 'abc', qty: 1 }] })).status === 400);
    check('empty order rejected', (await bad({ items: [] })).status === 400);
    check('qty over stock rejected', (await bad({ items: [{ dishId: orderable.id, qty: 99 }] })).status === 400);
    check('duplicate dish rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1 }, { dishId: orderable.id, qty: 1 }] })).status === 400);
    check('bad room rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1 }], hostelRoom: 'ZZ9' })).status === 400);
    check('long note rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1 }], note: 'x'.repeat(200) })).status === 400);
    check('bad pickup slot rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1 }], pickupSlot: '99:99' })).status === 400);
    check('past pickup slot rejected', (await bad({ items: [{ dishId: orderable.id, qty: 1 }], pickupSlot: '07:00' })).status === 400);

    /* ---------------------------------------------- pickup slots */
    section('pickup slots');
    const slots = await call('/api/pickup-slots');
    check('slots offered', Array.isArray(slots.json.slots));
    check('slots are 15 min apart', slots.json.slots.every((s) => Number(s.slot.split(':')[1]) % 15 === 0));
    check('slots have capacity', slots.json.slots.every((s) => s.capacity > 0));

    /* --------------------------------------------------- ordering */
    section('ordering');
    const stockBefore = (await call(`/api/menu/${orderable.id}`)).json.stock;
    const slot = slots.json.slots.find((s) => !s.full);

    const placed = await call('/api/orders', {
      method: 'POST',
      idem: IDEM,
      body: {
        items: [{ dishId: orderable.id, qty: 1 }],
        hostelRoom: 'b-204',
        note: 'less spicy',
        pickupSlot: slot ? slot.slot : null,
        tipPercent: 5,
      },
    });

    check('order created', placed.status === 201 && /^CC-\d{4}$/.test(placed.json.token));
    check('price comes from the menu', placed.json.items[0].price === orderable.price);
    check('room normalised', placed.json.hostelRoom === 'B-204');
    check('eta is sensible', placed.json.etaMinutes > 0 && placed.json.etaMinutes <= 45);
    check('points earned recorded', placed.json.pointsEarned >= 0);

    const repeat = await call('/api/orders', {
      method: 'POST',
      idem: IDEM,
      body: { items: [{ dishId: orderable.id, qty: 1 }] },
    });
    check('same idempotency key does not duplicate', repeat.json.token === placed.json.token);

    const tampered = await call('/api/orders', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1, price: 1 }] },
    });
    check('client price is ignored', tampered.json.items[0].price === orderable.price);

    const after = (await call(`/api/menu/${orderable.id}`)).json.stock;
    check('stock went down by 2', after === stockBefore - 2, `${after} vs ${stockBefore - 2}`);

    /* ------------------------------------------------ state machine */
    section('order status');
    const token = placed.json.token;
    const patch = (status) => call(`/api/orders/${token}/status`, { method: 'PATCH', body: { status } });

    check('skipping ahead refused', (await patch('ready')).status === 409);
    check('unknown status refused', (await patch('flying')).status === 409);
    check('placed -> accepted allowed', (await patch('accepted')).status === 200);
    check('accepted -> preparing allowed', (await patch('preparing')).status === 200);
    check('cancel after preparing refused', (await patch('cancelled')).status === 409);
    check('preparing -> ready allowed', (await patch('ready')).status === 200);
    check('ready -> picked allowed', (await patch('picked')).status === 200);
    check('history is recorded', (await call(`/api/orders/${token}`)).json.history.length === 5);

    /* ------------------------------------------------------ ratings */
    section('ratings');
    check('rating a non-picked order refused', (await call(`/api/orders/${tampered.json.token}/rate`, {
      method: 'POST', body: { ratings: [{ dishId: orderable.id, stars: 5 }] },
    })).status === 409);

    check('stars out of range refused', (await call(`/api/orders/${token}/rate`, {
      method: 'POST', body: { ratings: [{ dishId: orderable.id, stars: 9 }] },
    })).status === 400);

    check('rating a dish not in the order refused', (await call(`/api/orders/${token}/rate`, {
      method: 'POST', body: { ratings: [{ dishId: 99999, stars: 4 }] },
    })).status === 400);

    check('rating works', (await call(`/api/orders/${token}/rate`, {
      method: 'POST', body: { ratings: [{ dishId: orderable.id, stars: 5 }] },
    })).status === 200);

    check('double rating refused', (await call(`/api/orders/${token}/rate`, {
      method: 'POST', body: { ratings: [{ dishId: orderable.id, stars: 1 }] },
    })).status === 409);

    /* ------------------------------------------------ cancel + stock */
    section('cancelling');
    const second = await call('/api/orders', { method: 'POST', body: { items: [{ dishId: orderable.id, qty: 1 }] } });
    const midStock = (await call(`/api/menu/${orderable.id}`)).json.stock;
    await call(`/api/orders/${second.json.token}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    const backStock = (await call(`/api/menu/${orderable.id}`)).json.stock;
    check('cancel puts stock back', backStock === midStock + 1, `${backStock} vs ${midStock + 1}`);

    /* ------------------------------------------------------ loyalty */
    section('loyalty');
    const member = await call(`/api/members/${MEMBER}`);
    check('member has points', member.json.points >= 0);
    check('member has a tier', typeof member.json.tier === 'string');

    const tooMany = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], redeemPoints: 99999 },
    });
    check('spending points you lack refused', tooMany.json.pointsRedeemed === 0 && !!tooMany.json.pointsError);

    const oddPoints = await call('/api/cart/quote', {
      method: 'POST',
      body: { items: [{ dishId: orderable.id, qty: 1 }], redeemPoints: 37 },
    });
    check('points must be in blocks of 50', oddPoints.json.pointsRedeemed === 0);

    /* -------------------------------------------------------- staff */
    section('staff');
    check('bad stock refused', (await call(`/api/menu/${orderable.id}/stock`, { method: 'PATCH', body: { stock: -2 } })).status === 400);
    check('huge stock refused', (await call(`/api/menu/${orderable.id}/stock`, { method: 'PATCH', body: { stock: 500 } })).status === 400);
    check('stock update works', (await call(`/api/menu/${orderable.id}/stock`, { method: 'PATCH', body: { stock: 7 } })).json.stock === 7);

    const off = await call(`/api/menu/${orderable.id}/availability`, { method: 'PATCH', body: { disabled: true } });
    check('dish can be taken off the menu', off.json.disabled === true);
    check('an off-menu dish cannot be ordered', (await bad({ items: [{ dishId: orderable.id, qty: 1 }] })).status === 400);
    await call(`/api/menu/${orderable.id}/availability`, { method: 'PATCH', body: { disabled: false } });

    const stats = await call('/api/stats');
    check('stats respond', stats.status === 200 && typeof stats.json.revenue === 'number');
    check('stats list top dishes', Array.isArray(stats.json.topDishes));
    check('stats count the queue', typeof stats.json.queue === 'number');

    const list = await call('/api/orders?limit=5');
    check('staff order list works', list.json.orders.length > 0);
    check('orders carry allowedNext', Array.isArray(list.json.orders[0].allowedNext));
  }

  /* -------------------------------------------------------- frontend */
  section('frontend');
  check('page is served', (await fetch(BASE + '/')).status === 200);
  check('scripts are served', (await fetch(BASE + '/js/app.js')).status === 200);
  check('styles are served', (await fetch(BASE + '/style.css')).status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) console.log('failed: ' + failures.join(', '));
  process.exit(fail === 0 ? 0 : 1);
})();
