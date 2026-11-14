// Launch Radar dashboard. Reads window.RADAR (data.js, written beside this
// page by main.ts from the same board board.json carries) and renders the
// board, a per-protocol detail, the products set aside and the tokens
// already trading. No network, no framework: every figure is in data.js,
// and the detail view recomputes implied value live from shipped factors.
(function () {
  'use strict';
  var DATA = window.RADAR, app = document.getElementById('app');
  if (!DATA || !app) return;
  var M = DATA.meta;

  // ---- formatting ----
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) { var m = n / 1e6; return '$' + (Math.abs(m) < 10 ? m.toFixed(2) : m.toFixed(1)) + 'M'; }
    if (a >= 1e3) { var k = n / 1e3; return '$' + (Math.abs(k) < 100 ? k.toFixed(2) : k.toFixed(1)) + 'K'; }
    return '$' + Math.round(n);
  }
  function fmtFull(n) { return n === null || n === undefined ? 'n/a' : '$' + Math.round(n).toLocaleString('en-US'); }
  function fmtPct(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    return d >= 365 ? (d / 365).toFixed(1) + 'y (' + d + 'd)' : d + 'd';
  }
  function badge(r) {
    if (r.watchlist) return '<span class="pill pill-watch">WATCHLIST</span>';
    if (r.tvl_usd < 50000000) return '<span class="pill pill-early">EARLY</span>';
    return '';
  }
  function badgeDetail(r) {
    if (r.watchlist) return '<span class="pill pill-watch">WATCHLIST</span>';
    if (r.tvl_usd < 50000000) return '<span class="pill pill-early">EARLY — BELOW THE $50M FLOOR</span>';
    return '<span class="pill pill-plain">PRE-TOKEN</span>';
  }
  // One model for page and board: implied value recomputed live from the
  // shipped factors is the number board.json carries.
  function impliedLive(r) {
    var f = r.factors;
    return Math.max(1, Math.round(r.tvl_usd * f.category_multiple * f.momentum * f.seasoning * f.breadth));
  }
  // A farm step's tail, " [cost $X | Y min]", parsed into its two pills.
  function parseStep(step) {
    var m = /\[cost \$(\d+) \| (\d+) min\]\s*$/.exec(step);
    if (!m) return { text: step, cost: null, minutes: null };
    return { text: step.slice(0, m.index).trim(), cost: Number(m[1]), minutes: Number(m[2]) };
  }
  function chgCell(v) {
    return v === null ? '<td class="num">n/a</td>' : '<td class="num ' + (v >= 0 ? 'pos' : 'neg') + '">' + fmtPct(v) + '</td>';
  }

  // ---- url state: view, slug, category, chain, tier and sort live in the
  // URL (query string when served, hash on a file:// page), restored on load.
  function readParams() {
    var out = {};
    function eat(str) { if (str) new URLSearchParams(str).forEach(function (v, k) { out[k] = v; }); }
    eat(window.location.search.replace(/^\?/, ''));
    eat(window.location.hash.replace(/^#\/?/, ''));
    return out;
  }
  var state = { view: 'board', slug: null, q: '', category: 'all', chain: 'all', tier: 'all', sort: 'rank', dir: 1 };
  function applyParams(p, lenient) {
    if (['board', 'detail', 'products', 'live'].indexOf(p.view) >= 0) state.view = p.view;
    else if (!lenient) state.view = 'board';
    state.slug = p.slug || null;
    if (state.slug && !p.view) state.view = 'detail';
    state.q = p.q || '';
    state.category = p.category || 'all';
    state.chain = p.chain || 'all';
    state.tier = p.tier || 'all';
    state.sort = p.sort || 'rank';
    state.dir = p.dir === '-1' ? -1 : 1;
    if (state.view === 'detail' && !state.slug) state.view = 'board';
  }
  applyParams(readParams(), true);
  function writeParams(push) {
    var p = new URLSearchParams();
    p.set('view', state.view);
    if (state.view === 'detail' && state.slug) p.set('slug', state.slug);
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.tier !== 'all') p.set('tier', state.tier);
    if (state.sort !== 'rank') p.set('sort', state.sort);
    if (state.dir !== 1) p.set('dir', String(state.dir));
    var url = window.location.pathname + '#' + p.toString();
    if (push) window.history.pushState(null, '', url); else window.history.replaceState(null, '', url);
  }
  function go(view, slug) { state.view = view; state.slug = slug || null; writeParams(true); render(); window.scrollTo(0, 0); }

  // ---- filtering and sorting ----
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.tier === 'watchlist' && !r.watchlist) return false;
      if (state.tier === 'early' && !(r.tvl_usd < 50000000)) return false;
      if (q && (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function sortedRows(list) {
    var key = state.sort, dir = state.dir;
    function val(r) {
      if (key === 'name') return r.name.toLowerCase();
      if (key === 'tvl') return r.tvl_usd;
      if (key === 'change') return r.change_7d === null ? -Infinity : r.change_7d;
      if (key === 'age') return r.age_days;
      if (key === 'mult') return r.factors.category_multiple;
      if (key === 'implied') return r.implied_value_usd;
      return r.rank;
    }
    return list.slice().sort(function (a, b) {
      var av = val(a), bv = val(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  // ---- shared chrome ----
  function headerHtml() {
    return '<header class="top"><div class="brand"><span class="brand-dot"></span><span class="brand-name">Launch Radar</span>' +
      '<span class="brand-sub">pre-token protocols, priced before they launch</span></div><div class="stats">' +
      '<div class="stat"><span>Protocols scanned</span><b>' + M.scanned + '</b></div>' +
      '<div class="stat"><span>Candidates ranked</span><b>' + M.candidates + '</b></div>' +
      '<div class="stat"><span>Watchlist coverage</span><b>' + M.watchlist_size + '/' + M.watchlist_size + '</b></div>' +
      '<div class="stat"><span>Snapshot date</span><b>' + esc(M.as_of) + '</b></div></div></header>';
  }
  function methodHtml() {
    var half = Math.ceil(DATA.multiples.length / 2), bt = DATA.backtest;
    function table(rows) {
      var h = '<table class="mults"><thead><tr><th>Category</th><th class="num">Peers</th><th class="num">Peer median</th><th class="num">Multiple used</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        h += '<tr><td>' + esc(r.category) + '</td><td class="num">' + r.peers + '</td><td class="num">' +
          (r.peer_median === null ? '—' : r.peer_median.toFixed(4)) + '</td><td class="num strong">' + r.multiple.toFixed(4) + '</td></tr>';
      });
      return h + '</tbody></table>';
    }
    return '<section class="panel method"><div class="method-head"><h2>How the implied value is priced</h2>' +
      '<p class="formula">implied value = TVL &times; category multiple &times; momentum &times; seasoning &times; breadth</p></div>' +
      '<div class="method-grid"><div class="method-prose">' +
      '<p><b>Category multiple.</b> Every tokenised protocol with a usable market cap is a peer: its multiple is market cap / TVL. A category is priced at the median of its peers\' multiples, shrunk toward the global median (' + M.global_median.toFixed(4) + ' across ' + M.peer_total + ' peers) with K = 6 pseudo-peers — mult = (n &times; category median + 6 &times; global median) / (n + 6) — or K = 12 under 3 peers, so thin peer sets pull harder toward the market. The result is clamped to [0.02, 2.00]; a category with no peers uses the global median itself. Detail pages repeat the same shrink and clamp with the category\'s Q1 / Q3 multiples for the value range.</p>' +
      '<p><b>Momentum</b> is 1 + 0.5 &times; the seven-day TVL change clamped to [-50%, +100%] — a factor of 0.75 to 1.50, so one week can neither halve nor more than half-again the price. <b>Seasoning</b> is 1 + 0.20 &times; min(age, 1460) / 1460, at most &times;1.20 at four years, paying for time survived with no token; unlisted records take the pre-token median age, ' + M.median_age_days + ' days. <b>Breadth</b> is 1 + 0.03 per chain past the first, capped at &times;1.21. Sixteen tokenised records carry a $0 or negative placeholder cap; they sit out the peer set and the backtest.</p>' +
      '<p><b>Backtest.</b> Pricing the ' + bt.tested + ' peers with their own category multiples — fitted = TVL &times; shrunk multiple, against the recorded caps — gives a median absolute error of ' + (bt.median_ape * 100).toFixed(1) + '% and a hit rate of ' + (bt.hit_rate * 100).toFixed(1) + '% (' + bt.hits + ' of ' + bt.tested + ' fitted values inside [0.5&times;, 2&times;] of the actual cap). A blunt peer ruler, not a price prediction.</p>' +
      '<p class="honest"><b>Set aside, honestly.</b> Of ' + M.scanned + ' records scanned, ' + M.pre_token + ' record no token at all; ' + M.products + ' of those are products — wrapped, staked, bridged, versioned or exchange records — each named with its rule in the Products view, leaving the ' + M.candidates + ' candidates ranked here. Tokens that already trade are never ranked: the ' + M.live_shown + ' largest stand at market values in the Already trading view; the rest are deployments of families that already trade.</p>' +
      '</div><div class="method-tables">' + table(DATA.multiples.slice(0, half)) + table(DATA.multiples.slice(half)) + '</div></div></section>';
  }
  function tabsHtml() {
    function tab(v, label) {
      var on = state.view === v || (v === 'board' && state.view === 'detail');
      return '<button type="button" class="tab' + (on ? ' tab-on' : '') + '" data-go="' + v + '">' + label + '</button>';
    }
    return '<nav class="tabs">' + tab('board', 'Launch board') + tab('products', 'Products set aside (' + M.products + ')') +
      tab('live', 'Already trading (' + M.live_shown + ')') + '</nav>';
  }
  function controlsHtml(count) {
    var catCounts = {}, chainSet = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Uncategorised';
      catCounts[c] = (catCounts[c] || 0) + 1;
      (r.chains || []).forEach(function (x) { chainSet[x] = true; });
    });
    var h = '<div class="controls"><label class="field grow"><span>Search</span><input id="f-q" type="search" placeholder="Name, slug or category" value="' + esc(state.q) + '"></label>' +
      '<label class="field"><span>Category</span><select id="f-cat"><option value="all">All categories</option>';
    Object.keys(catCounts).sort().forEach(function (c) {
      h += '<option value="' + esc(c) + '"' + (state.category === c ? ' selected' : '') + '>' + esc(c) + ' (' + catCounts[c] + ')</option>';
    });
    h += '</select></label><label class="field"><span>Chain</span><select id="f-chain"><option value="all">All chains</option>';
    Object.keys(chainSet).sort().forEach(function (c) {
      h += '<option value="' + esc(c) + '"' + (state.chain === c ? ' selected' : '') + '>' + esc(c) + '</option>';
    });
    h += '</select></label><label class="field"><span>Tier</span><select id="f-tier">' +
      '<option value="all"' + (state.tier === 'all' ? ' selected' : '') + '>All candidates</option>' +
      '<option value="watchlist"' + (state.tier === 'watchlist' ? ' selected' : '') + '>Watchlist</option>' +
      '<option value="early"' + (state.tier === 'early' ? ' selected' : '') + '>Early</option></select></label>' +
      '<span class="count" id="f-count">' + count + ' of ' + M.candidates + ' candidates</span></div>';
    return h;
  }
  function footerHtml() {
    return '<footer class="foot">One model for page and board — snapshot ' + esc(M.as_of) + ' — ' + M.candidates + ' of ' + M.scanned +
      ' scanned. Implied values are this radar\'s own model claims, not prices or promises. Source: ' + esc(M.source) + '.</footer>';
  }

  // ---- board view ----
  function sortHead(key, label, cls) {
    var ind = state.sort === key ? (state.dir === 1 ? ' ^' : ' v') : '';
    return '<th class="' + (cls || '') + '"><button type="button" class="sortbtn" data-sort="' + key + '">' + label + ind + '</button></th>';
  }
  function rowHtml(r) {
    return '<tr class="rowlink" data-slug="' + esc(r.slug) + '" tabindex="0"><td class="num rank">' + r.rank + '</td>' +
      '<td><div class="pname"><b>' + esc(r.name) + '</b> ' + badge(r) + '</div><div class="sub">' + esc(r.category || 'Uncategorised') +
      ' · ' + esc((r.chains || [])[0] || '—') + '</div></td><td class="num">' + fmtUsd(r.tvl_usd) + '</td>' + chgCell(r.change_7d) +
      '<td class="num">' + fmtAge(r.age_days) + '</td><td class="num">&times;' + r.factors.category_multiple.toFixed(4) + '</td>' +
      '<td class="num strong">' + fmtUsd(r.implied_value_usd) + '</td></tr>';
  }
  function boardHtml() {
    var list = sortedRows(filteredRows());
    var h = headerHtml() + methodHtml() + tabsHtml() + controlsHtml(list.length);
    if (list.length === 0) {
      return h + '<section class="panel empty"><h2>No candidate matches that filter</h2><p>Clear the search or widen the category, chain or tier to see the board again.</p></section>' + footerHtml();
    }
    h += '<section class="panel"><div class="table-wrap"><table class="board"><thead><tr>' + sortHead('rank', '#') + sortHead('name', 'Protocol') +
      sortHead('tvl', 'TVL', 'num') + sortHead('change', '7d', 'num') + sortHead('age', 'Age', 'num') + sortHead('mult', 'x Mult', 'num') +
      sortHead('implied', 'Implied value', 'num') + '</tr></thead><tbody>';
    list.forEach(function (r) { h += rowHtml(r); });
    return h + '</tbody></table></div></section>' + footerHtml();
  }

  // ---- detail view ----
  function detailHtml(row) {
    var f = row.factors, live = impliedLive(row), plan = row.plan;
    var catRow = null;
    DATA.multiples.forEach(function (mr) { if (mr.category === (row.category || 'Uncategorised')) catRow = mr; });
    var peers = DATA.peers[row.category || 'Uncategorised'] || [];
    var h = headerHtml() + '<div class="detail-top"><button type="button" class="backlink" data-go="board">&larr; Back to the board</button></div>' +
      '<section class="detail-head panel"><div><h1>' + esc(row.name) + ' ' + badgeDetail(row) + '</h1>' +
      '<p class="sub">Rank #' + row.rank + ' of ' + M.candidates + ' · ' + esc(row.category || 'Uncategorised') + ' · records no token in the ' + esc(M.as_of) + ' snapshot</p></div>' +
      '<div class="detail-value"><span>Implied value</span><b>' + fmtUsd(row.implied_value_usd) + '</b><span class="sub">' + fmtFull(row.implied_value_usd) + '</span></div></section>' +
      '<div class="detail-grid"><section class="panel pad"><h2>The record</h2><dl class="kv">' +
      '<div><dt>TVL</dt><dd class="num">' + fmtFull(row.tvl_usd) + '</dd></div>' +
      '<div><dt>7d change</dt><dd class="num ' + (row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg') + '">' + fmtPct(row.change_7d) + '</dd></div>' +
      '<div><dt>Chains</dt><dd>' + esc((row.chains || []).join(', ') || '—') + '</dd></div>' +
      '<div><dt>Tracked since</dt><dd>' + (row.listed_at ? esc(row.listed_at) : 'not recorded — seasoned at the ' + M.median_age_days + '-day pre-token median') + '</dd></div>' +
      '<div><dt>Age with no token</dt><dd class="num">' + fmtAge(row.age_days) + '</dd></div>' +
      '<div><dt>Watchlist rule</dt><dd>' + (row.watchlist
        ? 'On the snapshot watchlist: TVL at or above the $50.00M floor, no token recorded, and not a wrapped, staked or bridged product.'
        : 'Not on the watchlist — ranked anyway: the watchlist is a floor, never a ceiling, and this record is a pre-token protocol that is not a product.') + '</dd></div></dl></section>' +
      '<section class="panel pad"><h2>The model\'s arithmetic</h2><div class="chips">' +
      '<span class="chip">TVL <b class="num">' + fmtUsd(row.tvl_usd) + '</b></span><span class="op">&times;</span>' +
      '<span class="chip">multiple <b class="num">' + f.category_multiple.toFixed(4) + '</b></span><span class="op">&times;</span>' +
      '<span class="chip">momentum <b class="num">' + f.momentum.toFixed(4) + '</b></span><span class="op">&times;</span>' +
      '<span class="chip">seasoning <b class="num">' + f.seasoning.toFixed(4) + '</b></span><span class="op">&times;</span>' +
      '<span class="chip">breadth <b class="num">' + f.breadth.toFixed(4) + '</b></span><span class="op">=</span>' +
      '<span class="chip chip-out">implied <b class="num">' + fmtUsd(live) + '</b></span></div>' +
      '<p class="sub check">Recomputed live on this page from the shipped factors: ' + fmtFull(live) +
      (live === row.implied_value_usd ? ' — the same number board.json carries.' : ' — differs from board.json, so the data would be stale.') + '</p>' +
      '<p>The ' + esc(row.category || 'Uncategorised') + ' multiple comes from ' + f.peer_count + ' tokenised peer' + (f.peer_count === 1 ? '' : 's') +
      (catRow && catRow.peer_median !== null ? ' with a peer median of ' + catRow.peer_median.toFixed(4) : ' — this category has no tokenised peers, so it is priced at the global median itself') +
      ', shrunk toward the global median of ' + M.global_median.toFixed(4) + ' with K = ' + (f.peer_count < 3 ? '12' : '6') + ' pseudo-peers and clamped to [0.02, 2.00], giving ' + f.category_multiple.toFixed(4) +
      '. Momentum reads the seven-day change (' + fmtPct(row.change_7d) + ', clamped); seasoning pays for ' + row.age_days + ' days with no token; breadth counts ' +
      (row.chains || []).length + ' chain' + ((row.chains || []).length === 1 ? '' : 's') + '.</p>' +
      '<p><b>Value range.</b> Repricing with the category\'s quartile multiples (' + f.multiple_lo.toFixed(4) + ' to ' + f.multiple_hi.toFixed(4) +
      ', same shrink and clamp) gives <b class="num">' + fmtUsd(row.value_lo_usd) + ' – ' + fmtUsd(row.value_hi_usd) + '</b>: the peer set\'s own disagreement, shown rather than hidden.</p>';
    if (peers.length > 0) {
      h += '<h3>The peers behind the multiple</h3><table class="peers"><thead><tr><th>Peer</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">mcap / TVL</th></tr></thead><tbody>';
      peers.forEach(function (p) {
        h += '<tr><td>' + esc(p.name) + '</td><td class="num">' + fmtUsd(p.tvl_usd) + '</td><td class="num">' + fmtUsd(p.mcap_usd) + '</td><td class="num">' + p.multiple.toFixed(4) + '</td></tr>';
      });
      h += '</tbody></table>';
    } else {
      h += '<p class="sub">No tokenised protocol in this category carries a usable market cap, so no peer table stands behind this multiple: the global median is the whole of it.</p>';
    }
    h += '</section></div><section class="panel pad plan"><h2>The farm plan</h2><div class="chips">' +
      '<span class="chip">Working capital <b class="num">' + fmtFull(plan.capital_usd) + '</b></span>' +
      '<span class="chip">Gas, whole plan <b class="num">' + fmtFull(plan.gas_usd) + '</b></span>' +
      '<span class="chip">Hold <b class="num">' + plan.hold_days + ' days</b></span>' +
      '<span class="chip">Cadence <b class="num">' + plan.minutes_per_week + ' min/week</b></span>' +
      '<span class="chip">Hands-on total <b class="num">' + plan.minutes_total + ' min</b></span></div>' +
      '<p class="sub">Working capital is deployed, not spent: it stays in the position and comes back on unwind. The only out-of-pocket cost is gas and fees — ' +
      fmtFull(plan.gas_usd) + ' across all eight steps, priced off the lead chain, ' + esc((row.chains || [])[0] || 'its main chain') + '.</p><ol class="steps">';
    row.farm_steps.forEach(function (s) {
      var p = parseStep(s);
      h += '<li><span class="step-text">' + esc(p.text) + '</span><span class="pills">' +
        (p.cost !== null ? '<span class="pill pill-cost">Cost $' + p.cost + '</span><span class="pill pill-time">' + p.minutes + ' min</span>' : '') + '</span></li>';
    });
    return h + '</ol></section>' + footerHtml();
  }

  // ---- products and live views ----
  function productsHtml() {
    var h = headerHtml() + tabsHtml() + '<section class="panel pad"><h1>Products set aside</h1><p class="sub">' + M.products +
      ' pre-token records are products of tokens that already trade — wrapped, staked, bridged, versioned or exchange records — not protocols awaiting a launch. Each stands at its own TVL with the rule that set it aside. None is ranked.</p></section>' +
      '<section class="panel"><div class="table-wrap"><table class="board"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th>Rule that set it aside</th></tr></thead><tbody>';
    DATA.products.forEach(function (p) {
      h += '<tr><td><div class="pname"><b>' + esc(p.name) + '</b></div><div class="sub">' + esc(p.category || 'Uncategorised') + ' · ' +
        esc((p.chains || [])[0] || '—') + '</div></td><td class="num">' + fmtUsd(p.tvl_usd) + '</td>' + chgCell(p.change_7d) +
        '<td class="rule">' + esc(p.rule) + '</td></tr>';
    });
    return h + '</tbody></table></div></section>' + footerHtml();
  }
  function liveHtml() {
    var h = headerHtml() + tabsHtml() + '<section class="panel pad"><h1>Already trading</h1><p class="sub">The ' + M.live_shown +
      ' largest tokenised protocols by market cap. Their tokens already trade, so the value shown is the market\'s own figure, not the model\'s — <b>UNRANKED</b>, never on the board. The peer set behind the multiples is ' + M.peer_total + ' protocols.</p></section>' +
      '<section class="panel"><div class="table-wrap"><table class="board"><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Market cap</th><th>Status</th></tr></thead><tbody>';
    DATA.live.forEach(function (p) {
      h += '<tr><td><div class="pname"><b>' + esc(p.name) + '</b>' + (p.symbol ? ' <span class="sub">' + esc(p.symbol) + '</span>' : '') +
        '</div><div class="sub">' + esc(p.category || 'Uncategorised') + ' · ' + esc((p.chains || [])[0] || '—') + '</div></td><td class="num">' +
        fmtUsd(p.tvl_usd) + '</td>' + chgCell(p.change_7d) + '<td class="num strong">' + fmtUsd(p.mcap_usd) +
        '</td><td><span class="pill pill-live">UNRANKED — ALREADY TRADING</span></td></tr>';
    });
    return h + '</tbody></table></div></section>' + footerHtml();
  }

  // ---- render and wiring ----
  function render() {
    var html;
    if (state.view === 'detail') {
      var row = null;
      DATA.rows.forEach(function (r) { if (r.slug === state.slug) row = r; });
      html = row ? detailHtml(row) : boardHtml();
    } else if (state.view === 'products') html = productsHtml();
    else if (state.view === 'live') html = liveHtml();
    else html = boardHtml();
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    wire();
  }
  function wireRows(scope) {
    scope.querySelectorAll('tr.rowlink').forEach(function (tr) {
      function open() { go('detail', tr.getAttribute('data-slug')); }
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }
  function wire() {
    app.querySelectorAll('[data-go]').forEach(function (n) {
      n.addEventListener('click', function () { go(n.getAttribute('data-go'), null); });
    });
    wireRows(app);
    app.querySelectorAll('.sortbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-sort');
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; state.dir = k === 'rank' || k === 'name' ? 1 : -1; }
        writeParams(false);
        render();
      });
    });
    var q = document.getElementById('f-q');
    if (q) q.addEventListener('input', function () {
      state.q = q.value;
      writeParams(false);
      var tbody = app.querySelector('table.board tbody'), count = document.getElementById('f-count');
      var list = sortedRows(filteredRows());
      if (count) count.textContent = list.length + ' of ' + M.candidates + ' candidates';
      if (tbody) {
        tbody.innerHTML = list.length ? list.map(rowHtml).join('') : '<tr><td colspan="7" class="sub">No candidate matches that filter.</td></tr>';
        wireRows(tbody);
      }
    });
    [['f-cat', 'category'], ['f-chain', 'chain'], ['f-tier', 'tier']].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el) el.addEventListener('change', function () { state[pair[1]] = el.value; writeParams(false); render(); });
    });
  }
  window.addEventListener('popstate', function () { applyParams(readParams(), false); render(); });
  render();
})();
