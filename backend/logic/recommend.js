// logic/recommend.js
// "Often bought with" and the personalised strip on the menu page.
// All of it is counted from past orders; there is no magic here.

const MIN_PAIR_COUNT = 1;

/**
 * Count how often two dishes appear in the same order.
 * Returns a Map keyed "smallerId:largerId" -> count.
 */
function pairCounts(orders) {
  const pairs = new Map();

  orders
    .filter((o) => o.status !== 'cancelled')
    .forEach((order) => {
      const ids = [...new Set(order.items.map((l) => Number(l.dishId)))].sort((a, b) => a - b);

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${ids[i]}:${ids[j]}`;
          pairs.set(key, (pairs.get(key) || 0) + 1);
        }
      }
    });

  return pairs;
}

/** How many times each dish has been ordered. */
function orderCounts(orders) {
  const counts = new Map();

  orders
    .filter((o) => o.status !== 'cancelled')
    .forEach((order) =>
      order.items.forEach((line) => {
        const id = Number(line.dishId);
        counts.set(id, (counts.get(id) || 0) + line.qty);
      })
    );

  return counts;
}

/**
 * Dishes usually bought with this one.
 * Falls back to popular dishes in the same slot when there is no history.
 */
function alsoBought(dishId, orders, menu, limit = 3) {
  const id = Number(dishId);
  const pairs = pairCounts(orders);
  const scored = [];

  pairs.forEach((count, key) => {
    if (count < MIN_PAIR_COUNT) return;

    const [a, b] = key.split(':').map(Number);
    if (a !== id && b !== id) return;

    const otherId = a === id ? b : a;
    const dish = menu.find((d) => d.id === otherId);
    if (dish) scored.push({ dish, count });
  });

  scored.sort((x, y) => y.count - x.count || y.dish.rating - x.dish.rating);

  if (scored.length >= limit) {
    return scored.slice(0, limit).map((s) => s.dish);
  }

  // not enough history: pad with popular dishes from the same slot
  const source = menu.find((d) => d.id === id);
  const counts = orderCounts(orders);
  const chosen = new Set(scored.map((s) => s.dish.id).concat(id));

  const filler = menu
    .filter((d) => !chosen.has(d.id) && (!source || d.slot === source.slot || d.slot === 'allday'))
    .sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0) || b.rating - a.rating);

  return scored
    .map((s) => s.dish)
    .concat(filler)
    .slice(0, limit);
}

/**
 * The strip at the top of the menu: things this person ordered before,
 * then whatever is popular right now.
 */
function forMember(memberOrders, orders, menu, limit = 4) {
  const mine = orderCounts(memberOrders);
  const everyone = orderCounts(orders);

  const available = menu.filter((dish) => dish.orderable);
  const candidates = available.length > 0 ? available : menu;

  return candidates
    .map((dish) => ({
      dish,
      score:
        (mine.get(dish.id) || 0) * 5 +
        (everyone.get(dish.id) || 0) +
        (dish.rating || 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.dish);
}

/** Top sellers, for the staff dashboard. */
function topDishes(orders, limit = 5) {
  const counts = orderCounts(orders);
  const names = new Map();

  orders.forEach((o) => o.items.forEach((l) => names.set(Number(l.dishId), l.name)));

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([dishId, qty]) => ({ dishId, name: names.get(dishId) || `#${dishId}`, qty }));
}

module.exports = { pairCounts, orderCounts, alsoBought, forMember, topDishes };
