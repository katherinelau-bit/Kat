/* Wrapped: one person's month of spending with friends in a few numbers, for a picture they can share.
 * Shared by the browser and the tests. Every bill and every trip expense counts as one spend, sorted into a category
 * (food, transport, hotel, shopping...). Amounts come back in RM (hundredths).
 * month(bills, '2026-10', meOf, trips, tripMeOf) -> stats; meOf(bill) / tripMeOf(trip) is this person's member id there. */
(function (root, factory) {
  var m = factory(typeof Split !== 'undefined' ? Split : require('./split.js'), typeof Currency !== 'undefined' ? Currency : require('./currency.js'),
    typeof Settle !== 'undefined' ? Settle : require('./settle.js'));
  if (typeof module === 'object' && module.exports) module.exports = m; else root.Wrapped = m;
})(typeof self !== 'undefined' ? self : this, function (Split, Currency, Settle) {
  // Guessed from the bill name and dishes: the cuisine with the most matching words wins. Whole words only (plurals
  // too), so "roti" finds "Roti canai" but "mala" does not find "Malaysia".
  var CUISINES = [
    ['Mamak', ['mamak', 'roti canai', 'roti telur', 'roti tisu', 'roti bawang', 'teh tarik', 'milo ais', 'milo dinosaur', 'maggi goreng', 'mee goreng mamak', 'nasi kandar', 'murtabak', 'thosai', 'tosai', 'capati', 'chapati', 'roti', 'teh o', 'neslo']],
    ['Malay', ['nasi lemak', 'rendang', 'satay', 'sate', 'nasi goreng', 'nasi kerabu', 'nasi campur', 'ayam penyet', 'ikan bakar', 'laksa', 'mee rebus', 'soto', 'kuih', 'cendol', 'air sirap', 'sirap bandung', 'lontong', 'nasi ayam', 'kampung']],
    ['Chinese', ['dim sum', 'char kway teow', 'char kuey teow', 'ckt', 'chicken rice', 'nasi ayam hainan', 'wantan', 'wonton', 'bak kut teh', 'hotpot', 'hot pot', 'steamboat', 'dumpling', 'xiao long bao', 'yong tau foo', 'claypot', 'pan mee', 'chee cheong fun', 'siew mai', 'har gow', 'char siew', 'siu yuk', 'kopitiam', 'kaya toast', 'hokkien mee', 'yee sang', 'mala', 'zi char', 'tai chow']],
    ['Japanese', ['sushi', 'sashimi', 'ramen', 'udon', 'soba', 'tempura', 'katsu', 'donburi', 'gyudon', 'teriyaki', 'yakitori', 'takoyaki', 'matcha', 'miso', 'japanese', 'omakase', 'unagi', 'onigiri', 'izakaya', 'sake']],
    ['Korean', ['korean', 'kimchi', 'bibimbap', 'tteokbokki', 'bulgogi', 'samgyeopsal', 'jjajang', 'jjigae', 'kbbq', 'soju', 'japchae', 'korean fried chicken', 'gimbap', 'kimbap']],
    ['Thai', ['thai', 'tom yum', 'tomyam', 'tom yam', 'pad thai', 'green curry', 'som tam', 'mango sticky rice', 'mango rice', 'basil', 'kra pao', 'phad kra', 'thai tea', 'moo kata', 'mookata', 'pad see ew']],
    ['Indian', ['banana leaf', 'briyani', 'biryani', 'tandoori', 'naan', 'butter chicken', 'masala', 'dosa', 'paneer', 'tikka', 'dal', 'indian', 'lassi', 'thali']],
    ['Western', ['burger', 'pasta', 'spaghetti', 'carbonara', 'steak', 'pizza', 'fries', 'fish and chips', 'fish & chips', 'grill', 'lamb chop', 'chicken chop', 'western', 'salad', 'sandwich', 'brunch', 'eggs benedict', 'aglio olio']],
    ['Café', ['coffee', 'latte', 'cappuccino', 'americano', 'flat white', 'mocha', 'espresso', 'cafe', 'café', 'cake', 'croissant', 'waffle', 'dessert', 'bingsu', 'boba', 'bubble tea', 'tealive', 'starbucks', 'zus', 'chagee']],
    ['Fast food', ['mcd', 'mcdonald', 'kfc', 'burger king', 'subway', 'texas chicken', 'domino', 'pizza hut', 'marrybrown', 'a&w', '4fingers']],
  ];
  // What the money went on. Food is any cuisine above, or these general words.
  var CATEGORIES = [
    ['Food & drinks', ['dinner', 'lunch', 'breakfast', 'brunch', 'supper', 'makan', 'meal', 'food', 'restaurant', 'eat', 'drinks', 'beer', 'bar', 'snack', 'buffet', 'tapau', 'kopi', 'teh', 'nasi', 'mee', 'mi', 'chicken', 'ayam', 'ikan', 'fish', 'rice', 'noodle', 'soup', 'bbq', 'seafood', 'durian', 'fruit']],
    ['Transport', ['grab', 'taxi', 'uber', 'bolt', 'indrive', 'petrol', 'fuel', 'minyak', 'toll', 'tol', 'parking', 'train', 'mrt', 'lrt', 'ktm', 'ets', 'bus', 'flight', 'flights', 'air ticket', 'airasia', 'malaysia airlines', 'mas', 'firefly', 'batik air', 'airport', 'car rental', 'rent car', 'kereta sewa', 'ferry', 'boat', 'tuk tuk', 'tuktuk', 'bts', 'shinkansen', 'transport']],
    ['Hotel & stays', ['hotel', 'airbnb', 'hostel', 'resort', 'homestay', 'villa', 'chalet', 'motel', 'inn', 'accommodation', 'room', 'booking.com', 'agoda', 'stay', 'glamping', 'camping', 'staycation']],
    ['Shopping', ['shopping', 'shop', 'mall', 'uniqlo', 'zara', 'h&m', 'shopee', 'lazada', 'clothes', 'shirt', 'shoes', 'bag', 'gift', 'present', 'souvenir', 'ikea', 'mr diy', 'watsons', 'guardian', 'sephora', 'daiso', 'cosmetics', 'perfume', 'market', 'pasar']],
    ['Groceries', ['groceries', 'grocery', 'supermarket', 'tesco', 'lotus', 'aeon', 'jaya grocer', 'village grocer', 'mydin', 'giant', '99 speedmart', 'speedmart', 'econsave', 'hero market', 'nsk', 'barang dapur', 'household']],
    ['Fun & activities', ['movie', 'cinema', 'gsc', 'tgv', 'mbo', 'karaoke', 'ktv', 'concert', 'ticket', 'tickets', 'theme park', 'sunway lagoon', 'genting', 'entrance', 'tour', 'bowling', 'escape room', 'spa', 'massage', 'futsal', 'badminton', 'gym', 'snorkel', 'diving', 'island hopping', 'museum', 'zoo', 'aquarium', 'show', 'party', 'activity']],
    ['Bills & subscriptions', ['electric', 'electricity', 'tnb', 'water bill', 'air selangor', 'wifi', 'internet', 'unifi', 'maxis', 'celcom', 'digi', 'rent', 'sewa', 'netflix', 'spotify', 'disney', 'youtube premium', 'subscription', 'astro', 'insurance', 'utilities']],
  ];
  // The categories a bill or expense can have, in the order the app shows them. The key is what the server stores
  // (lib/core.js has the same keys); '' means none was picked, and the app guesses.
  var CATS = [{ key: 'food', name: 'Food & drinks', icon: '🍜' }, { key: 'transport', name: 'Transport', icon: '🚗' }, { key: 'stay', name: 'Hotel & stays', icon: '🏨' },
    { key: 'shopping', name: 'Shopping', icon: '🛍️' }, { key: 'groceries', name: 'Groceries', icon: '🛒' }, { key: 'fun', name: 'Fun & activities', icon: '🎡' },
    { key: 'bills', name: 'Bills & subscriptions', icon: '🧾' }, { key: 'other', name: 'Other', icon: '💸' }];
  var BYKEY = {}, BYNAME = {}; CATS.forEach(function (c) { BYKEY[c.key] = c; BYNAME[c.name] = c; });
  var CICON = {}; CATS.forEach(function (c) { CICON[c.name] = c.icon; });
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&'); };
  var words = function (list) { return list.map(function (w) { return new RegExp('(^|[^a-z])' + esc(w.trim()) + '(s|es)?($|[^a-z])', 'i'); }); };
  var RX = CUISINES.map(function (c) { return [c[0], words(c[1])]; }), CRX = CATEGORIES.map(function (c) { return [c[0], words(c[1])]; });
  // The name counts double: "Hotel" with a "Breakfast" line is a hotel.
  var score = function (rxs, text) { var n = 0; text.forEach(function (t, k) { rxs.forEach(function (rx) { if (rx.test(t || '')) n += k === 0 ? 2 : 1; }); }); return n; };
  function categoryOf(x) {
    var text = [x.title].concat((x.items || []).map(function (i) { return i.name; })), best = 'Other', top = 0;
    CRX.forEach(function (c) { var n = score(c[1], text) + (c[0] === 'Food & drinks' && cuisineOf(x) !== 'Other' ? 2 : 0); if (n > top) { top = n; best = c[0]; } });
    return best;
  }
  function cuisineOf(b) {
    var text = [b.title].concat((b.items || []).map(function (i) { return i.name; })), best = 'Other', top = 0;
    RX.forEach(function (c) {
      var n = 0; text.forEach(function (t, k) { c[1].forEach(function (rx) { if (rx.test(t || '')) n += k === 0 ? 2 : 1; }); });
      if (n > top) { top = n; best = c[0]; }
    });
    return best;
  }
  // The category key: the one picked, or the best guess.
  function guess(x) { return BYNAME[categoryOf(x)].key; }
  function categoryKey(x) { return BYKEY[x.category] ? x.category : guess(x); }

  var dayOf = function (ms) { return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10); };
  var monthOf = function (b) { return (/^\d{4}-\d{2}/.test(b.date || '') ? b.date : dayOf(b.createdAt)).slice(0, 7); };
  var rm = function (c, b) { return b.currency && b.currency !== 'MYR' ? Currency.toRM(c, b.rate) : c; };
  var tidy = function (s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); };
  function top(counts) { var best = null; Object.keys(counts).forEach(function (k) { if (!best || counts[k].n > counts[best].n) best = k; }); return best; }

  // Every bill and trip expense this person is part of, in one shape: what it was, when, how much (RM) and their part.
  function entries(bills, meOf, trips, tripMeOf) {
    var out = [];
    (bills || []).forEach(function (b) {
      var me = meOf(b); if (!me) return;
      var c = Split.calc(b);
      out.push({ title: b.title, category: b.category, items: b.items || [], month: monthOf(b), date: b.date || dayOf(b.createdAt), total: rm(c.total, b), mine: rm(c.per[me] ? c.per[me].total : 0, b),
        iPaid: b.payerId === me, others: b.members.filter(function (m) { return m.id !== me; }).map(function (m) { return m.name; }), bill: b, me: me });
    });
    (trips || []).forEach(function (t) {
      var me = tripMeOf ? tripMeOf(t) : null; if (!me) return;
      var name = function (id) { var m = t.members.filter(function (x) { return x.id === id; })[0]; return m ? m.name : ''; };
      t.expenses.forEach(function (e) {
        var sh = Settle.sharesRM(e), ids = Object.keys(sh).filter(function (id) { return sh[id] > 0; });
        if (e.paidBy !== me && !sh[me]) return;
        var d = /^\d{4}-\d{2}/.test(e.date || '') ? e.date : dayOf(e.createdAt || t.createdAt);
        out.push({ title: e.title, category: e.category, items: e.items || [], month: d.slice(0, 7), date: d, total: Settle.amountRM(e), mine: sh[me] || 0, iPaid: e.paidBy === me,
          others: ids.concat([e.paidBy]).filter(function (id, k, a) { return id !== me && a.indexOf(id) === k; }).map(name).filter(Boolean), trip: t.title });
      });
    });
    return out;
  }

  // The months (newest first) with at least one bill or trip expense this person is part of.
  function months(bills, meOf, trips, tripMeOf) {
    var seen = {}; entries(bills, meOf, trips, tripMeOf).forEach(function (x) { seen[x.month] = 1; });
    return Object.keys(seen).sort().reverse();
  }

  function month(bills, ym, meOf, trips, tripMeOf) {
    var list = entries(bills, meOf, trips, tripMeOf).filter(function (x) { return x.month === ym; });
    var s = { month: ym, count: list.length, bills: 0, expenses: 0, fronted: 0, frontedFor: 0, paidCount: 0, spent: 0, fastest: null, buddy: null, category: null, cuisine: null, dish: null, biggest: null, days: {} };
    var speed = {}, buddies = {}, cats = {}, cuisines = {}, dishes = {};
    list.forEach(function (x) {
      if (x.bill) s.bills++; else s.expenses++;
      s.spent += x.mine;
      if (x.iPaid) { s.paidCount++; s.fronted += x.total; s.frontedFor += x.total - x.mine; }
      // How long each friend took to pay back a bill this person paid: from the bill being made to their slip (or to
      // being marked paid). Trips settle up at the end, so they are left out of this one.
      if (x.bill && x.iPaid) x.bill.members.forEach(function (m) {
        if (m.id === x.me || !m.pay) return;
        var at = m.pay.slipAt || (m.pay.status === 'paid' ? m.pay.confirmedAt : 0);
        if (!at || at < x.bill.createdAt) return;
        var k = tidy(m.name); (speed[k] = speed[k] || { name: m.name, t: [] }).t.push(at - x.bill.createdAt);
      });
      x.others.forEach(function (n) { var k = tidy(n); if (k) (buddies[k] = buddies[k] || { name: n.trim(), n: 0 }).n++; });
      var cat = BYKEY[categoryKey(x)].name; (cats[cat] = cats[cat] || { n: 0, rm: 0 }); cats[cat].n++; cats[cat].rm += x.mine;
      if (cat === 'Food & drinks') { var cu = cuisineOf(x); if (cu !== 'Other') (cuisines[cu] = cuisines[cu] || { n: 0 }).n++; }
      x.items.forEach(function (i) { var k = tidy(i.name); if (k) (dishes[k] = dishes[k] || { name: i.name.trim(), n: 0 }).n++; });
      if (!s.biggest || x.total > s.biggest.total) s.biggest = { title: x.title, total: x.total, trip: x.trip || null };
      var wd = new Date(x.date + 'T00:00:00Z').getUTCDay(); s.days[wd] = (s.days[wd] || 0) + 1;
    });
    var fast = Object.keys(speed).map(function (k) { var t = speed[k].t; return { name: speed[k].name, avg: t.reduce(function (a, v) { return a + v; }, 0) / t.length, times: t.length }; })
      .sort(function (a, z) { return a.avg - z.avg; });
    s.fastest = fast[0] || null;
    var bk = top(buddies); if (bk) s.buddy = { name: buddies[bk].name, times: buddies[bk].n };
    // The category with the most money (this person's part); "Other" only wins when nothing else was recognised.
    var spentOn = Object.keys(cats).filter(function (k) { return k !== 'Other'; }).sort(function (a, z) { return cats[z].rm - cats[a].rm || cats[z].n - cats[a].n; });
    var ck = spentOn[0] || (cats.Other ? 'Other' : null);
    if (ck) s.category = { name: ck, icon: CICON[ck], pct: s.spent ? Math.round(cats[ck].rm / s.spent * 100) : Math.round(cats[ck].n / list.length * 100), times: cats[ck].n, rm: cats[ck].rm };
    var cuk = top(cuisines); if (cuk) s.cuisine = { name: cuk, times: cuisines[cuk].n };
    var dk = top(dishes); if (dk && dishes[dk].n > 1) s.dish = { name: dishes[dk].name, times: dishes[dk].n };
    var dd = Object.keys(s.days).sort(function (a, z) { return s.days[z] - s.days[a]; })[0];
    s.busiestDay = dd == null ? null : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dd];
    return s;
  }

  // "4 mins", "3 hours", "2 days".
  function took(ms) {
    var m = Math.max(1, Math.round(ms / 60000));
    if (m < 60) return m + (m === 1 ? ' min' : ' mins');
    var h = Math.round(m / 60); if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
    var d = Math.round(h / 24); return d + ' days';
  }

  return { cats: CATS, byKey: BYKEY, guess: guess, categoryKey: categoryKey, cuisineOf: cuisineOf, categoryOf: categoryOf, months: months, month: month, took: took, monthOf: monthOf };
});
