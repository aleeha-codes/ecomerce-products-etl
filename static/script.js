// =====================================================
// E-Commerce Dashboard - frontend logic
// Talks to the Python backend at /api/run
// =====================================================

const PALETTE = ["#4f46e5", "#7c3aed", "#db2777", "#f59e0b", "#10b981",
  "#0ea5e9", "#ef4444", "#84cc16", "#14b8a6", "#f97316"];

const STEP_NAMES = ["Extract", "Transform", "Validate", "Load", "EDA"];

const state = { products: [], sortKey: "id", sortDir: 1, page: 1, pageSize: 10, query: "" };
const charts = {};  // keeps chart objects so we can redraw them

const $ = (id) => document.getElementById(id);
const money = (n) => "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prevents text from the API from being treated as HTML
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// =====================================================
// 1. Run the pipeline
// =====================================================
async function runPipeline() {
  $("runBtn").disabled = true;
  $("runBtn").textContent = "Running...";
  $("errorBox").classList.add("hidden");
  showSteps(STEP_NAMES.map((n) => ({ name: n, detail: "Waiting..." })), "running");

  try {
    const response = await fetch("/api/run");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Server error");

    await animateSteps(data.steps);
    render(data);
  } catch (err) {
    $("errorBox").textContent = "Something went wrong: " + err.message;
    $("errorBox").classList.remove("hidden");
    showSteps(STEP_NAMES.map((n) => ({ name: n, detail: "Failed" })), "");
  } finally {
    $("runBtn").disabled = false;
    $("runBtn").textContent = "Run Pipeline Again";
  }
}

// =====================================================
// 2. Pipeline step cards
// =====================================================
function showSteps(steps, cls) {
  $("steps").innerHTML = steps.map((s) =>
    `<div class="step ${cls}"><div class="name">${esc(s.name)}</div><div class="detail">${esc(s.detail)}</div></div>`
  ).join("");
}

async function animateSteps(steps) {
  showSteps(steps, "");
  const cards = document.querySelectorAll(".step");
  for (const card of cards) {
    card.classList.add("running");
    await sleep(250);
    card.classList.remove("running");
    card.classList.add("done");
  }
}

// =====================================================
// 3. Draw everything
// =====================================================
function render(data) {
  renderKpis(data.kpis);
  renderCharts(data);
  renderSummary(data.summary);
  renderCorrelation(data.correlation);
  renderOutliers(data.outliers);
  renderRejected(data.rejected);

  state.products = data.products;
  state.page = 1;
  renderProducts();
}

function renderKpis(k) {
  const items = [
    ["Valid Products", k.valid, "green"],
    ["Rejected Rows", k.rejected, k.rejected > 0 ? "red" : "green"],
    ["Categories", k.categories, ""],
    ["Brands", k.brands, "pink"],
    ["Low Stock Items", k.low_stock, "orange"],
    ["Average Price", money(k.avg_price), ""],
  ];
  $("kpis").innerHTML = items.map(([label, value, cls]) =>
    `<div class="kpi ${cls}"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`
  ).join("");
}

// ---------- Charts ----------
function makeChart(id, config) {
  if (charts[id]) charts[id].destroy();  // remove the old chart before redrawing
  charts[id] = new Chart($(id), config);
}

function renderCharts(data) {
  Chart.defaults.font.family = '"Segoe UI", Roboto, Arial, sans-serif';
  Chart.defaults.maintainAspectRatio = false;

  const cats = data.by_category;  // already sorted by product count

  // 1. Products per category
  makeChart("chartCount", {
    type: "bar",
    data: {
      labels: cats.map((c) => c.category),
      datasets: [{ label: "Products", data: cats.map((c) => c.products), backgroundColor: "#4f46e5", borderRadius: 6 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { maxRotation: 60 } } } },
  });

  // 2. Average price by category (top 10)
  const byPrice = [...cats].sort((a, b) => b.avg_price - a.avg_price).slice(0, 10);
  makeChart("chartPrice", {
    type: "bar",
    data: {
      labels: byPrice.map((c) => c.category),
      datasets: [{ label: "Avg price ($)", data: byPrice.map((c) => c.avg_price), backgroundColor: PALETTE, borderRadius: 6 }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } } },
  });

  // 3. Price distribution
  makeChart("chartHist", {
    type: "bar",
    data: {
      labels: data.histogram.labels,
      datasets: [{ label: "Products", data: data.histogram.counts, backgroundColor: "#7c3aed", borderRadius: 4 }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: "Price range ($)" } } },
    },
  });

  // 4. Price vs rating
  makeChart("chartScatter", {
    type: "scatter",
    data: {
      datasets: [{
        label: "Products",
        data: data.scatter.map((p) => ({ x: p.price, y: p.rating, title: p.title })),
        backgroundColor: "rgba(219, 39, 119, 0.6)",
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.raw.title}: $${ctx.raw.x}, rating ${ctx.raw.y}` } },
      },
      scales: {
        x: { title: { display: true, text: "Price ($)" } },
        y: { title: { display: true, text: "Rating" }, min: 0, max: 5 },
      },
    },
  });

  // 5. Average rating by category
  const byRating = [...cats].sort((a, b) => b.avg_rating - a.avg_rating).slice(0, 10);
  makeChart("chartRating", {
    type: "bar",
    data: {
      labels: byRating.map((c) => c.category),
      datasets: [{ label: "Avg rating", data: byRating.map((c) => c.avg_rating), backgroundColor: "#10b981", borderRadius: 6 }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 5 }, x: { ticks: { maxRotation: 60 } } } },
  });

  // 6. Availability
  makeChart("chartAvail", {
    type: "doughnut",
    data: {
      labels: Object.keys(data.availability),
      datasets: [{ data: Object.values(data.availability), backgroundColor: ["#10b981", "#f59e0b", "#ef4444", "#6b7280"] }],
    },
    options: { plugins: { legend: { position: "bottom" } } },
  });
}

// ---------- Small tables ----------
function renderSummary(summary) {
  const rows = Object.entries(summary).map(([col, s]) =>
    `<tr><td><b>${esc(col)}</b></td><td>${s.mean}</td><td>${s.median}</td><td>${s.min}</td><td>${s.max}</td><td>${s.std ?? "-"}</td></tr>`
  ).join("");
  $("summaryTable").innerHTML =
    "<thead><tr><th>Column</th><th>Mean</th><th>Median</th><th>Min</th><th>Max</th><th>Std</th></tr></thead><tbody>" + rows + "</tbody>";
}

function renderCorrelation(c) {
  const head = "<thead><tr><th></th>" + c.labels.map((l) => `<th>${esc(l)}</th>`).join("") + "</tr></thead>";
  const body = c.matrix.map((row, i) =>
    `<tr><td><b>${esc(c.labels[i])}</b></td>` +
    row.map((v) => {
      if (v === null) return "<td>-</td>";
      const color = v >= 0 ? `rgba(79, 70, 229, ${Math.abs(v)})` : `rgba(220, 38, 38, ${Math.abs(v)})`;
      const text = Math.abs(v) > 0.5 ? "#fff" : "#1f2937";
      return `<td style="background:${color};color:${text}">${v}</td>`;
    }).join("") + "</tr>"
  ).join("");
  $("corrTable").innerHTML = head + "<tbody>" + body + "</tbody>";
}

function renderOutliers(o) {
  $("outlierNote").textContent = `(price above $${o.limit})`;
  if (o.rows.length === 0) {
    $("outlierTable").innerHTML = "<tbody><tr><td>No price outliers found.</td></tr></tbody>";
    return;
  }
  $("outlierTable").innerHTML =
    "<thead><tr><th>Title</th><th>Category</th><th>Price</th></tr></thead><tbody>" +
    o.rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.category)}</td><td>${money(r.price)}</td></tr>`).join("") +
    "</tbody>";
}

function renderRejected(rows) {
  $("rejectNote").textContent = `(${rows.length} rows)`;
  if (rows.length === 0) {
    $("rejectTable").innerHTML = "<tbody><tr><td>No rows were rejected. All data passed validation.</td></tr></tbody>";
    return;
  }
  $("rejectTable").innerHTML =
    "<thead><tr><th>ID</th><th>Title</th><th>Price</th><th>Rating</th><th>Stock</th><th>Problem</th></tr></thead><tbody>" +
    rows.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.price)}</td><td>${esc(r.rating)}</td><td>${esc(r.stock)}</td><td><span class="badge out">${esc(r.problem)}</span></td></tr>`).join("") +
    "</tbody>";
}

// =====================================================
// 4. Products table: search, sort, pages
// =====================================================
const COLUMNS = [
  ["id", "ID"], ["title", "Title"], ["category", "Category"], ["brand", "Brand"],
  ["price", "Price"], ["discount_pct", "Discount %"], ["final_price", "Final Price"],
  ["rating", "Rating"], ["stock", "Stock"], ["availability", "Availability"],
];

function availabilityBadge(text) {
  const t = String(text).toLowerCase();
  const cls = t.includes("out") ? "out" : t.includes("low") ? "low" : "in";
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function renderProducts() {
  // 1. filter by search text
  const q = state.query.toLowerCase();
  let rows = state.products.filter((p) =>
    [p.title, p.category, p.brand].some((v) => String(v ?? "").toLowerCase().includes(q)));

  // 2. sort
  rows.sort((a, b) => {
    const x = a[state.sortKey], y = b[state.sortKey];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (x > y ? 1 : -1) * state.sortDir;
  });

  // 3. pages
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  // 4. draw
  const arrow = (key) => (state.sortKey === key ? (state.sortDir === 1 ? " \u25B2" : " \u25BC") : "");
  const head = "<thead><tr>" +
    COLUMNS.map(([key, label]) => `<th class="sortable" data-key="${key}">${label}${arrow(key)}</th>`).join("") +
    "</tr></thead>";

  const body = pageRows.length === 0
    ? `<tbody><tr><td colspan="${COLUMNS.length}">No products match your search.</td></tr></tbody>`
    : "<tbody>" + pageRows.map((p) =>
      `<tr><td>${esc(p.id)}</td><td>${esc(p.title)}</td><td>${esc(p.category)}</td><td>${esc(p.brand)}</td>` +
      `<td>${money(p.price)}</td><td>${p.discount_pct ?? "-"}</td><td>${money(p.final_price)}</td>` +
      `<td>${p.rating}</td><td>${p.stock}</td><td>${availabilityBadge(p.availability)}</td></tr>`
    ).join("") + "</tbody>";

  $("productTable").innerHTML = head + body;
  $("pageInfo").textContent = `Page ${state.page} of ${totalPages}  (${rows.length} products)`;
  $("prevBtn").disabled = state.page <= 1;
  $("nextBtn").disabled = state.page >= totalPages;
}

// =====================================================
// 5. Events
// =====================================================
$("runBtn").addEventListener("click", runPipeline);

$("search").addEventListener("input", (e) => {
  state.query = e.target.value;
  state.page = 1;
  renderProducts();
});

$("prevBtn").addEventListener("click", () => { state.page--; renderProducts(); });
$("nextBtn").addEventListener("click", () => { state.page++; renderProducts(); });

// Click a column heading to sort
$("productTable").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.key;
  state.sortDir = state.sortKey === key ? -state.sortDir : 1;
  state.sortKey = key;
  renderProducts();
});

// Run automatically when the page opens
runPipeline();
