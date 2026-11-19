import { useCallback, useEffect, useRef, useState } from "react";
import { api, money } from "./api.js";

const categoryMark = { Coffee: "CO", Tea: "TE", Bakery: "BA", Food: "FO" };

function StockEditor({ product, onSave, disabled }) {
  const [stock, setStock] = useState(String(product.stock));
  useEffect(() => setStock(String(product.stock)), [product.stock]);
  return (
    <form className="stock-editor" onSubmit={(event) => {
      event.preventDefault();
      onSave(product.id, Number(stock));
    }}>
      <label className="sr-only" htmlFor={`stock-${product.id}`}>Stock for {product.name}</label>
      <input id={`stock-${product.id}`} type="number" min="0" max="1000000"
        required value={stock} onChange={(event) => setStock(event.target.value)} />
      <button className="button secondary small" disabled={disabled}>Save</button>
    </form>
  );
}

function ProductForm({ onSave, disabled }) {
  return (
    <form className="product-form panel" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const { price, ...values } = Object.fromEntries(new FormData(form));
      const saved = await onSave({
        ...values,
        price_cents: Math.round(Number(price) * 100),
        stock: Number(values.stock),
      });
      if (saved) form.reset();
    }}>
      <div><p className="eyebrow">GROW YOUR CATALOG</p><h2>Add a product</h2></div>
      <label>Product name<input name="name" required maxLength="100" placeholder="Oat milk latte" /></label>
      <label>SKU<input name="sku" required maxLength="40" pattern={"[A-Za-z0-9_\\-]+"} placeholder="COF-004" /></label>
      <label>Category<input name="category" required maxLength="100" placeholder="Coffee" /></label>
      <div className="form-row">
        <label>Price (USD)<input name="price" type="number" min="0.01" max="1000000" step="0.01" required placeholder="4.50" /></label>
        <label>Opening stock<input name="stock" type="number" min="0" max="1000000" required defaultValue="0" /></label>
      </div>
      <button className="button primary" disabled={disabled}>Add product</button>
    </form>
  );
}

function Receipt({ order, onClose }) {
  const closeButton = useRef(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    closeButton.current?.focus();
    const handleKey = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        event.preventDefault();
        closeButton.current?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="receipt panel" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
        <div className="success-mark" aria-hidden="true">OK</div>
        <p className="eyebrow">COUNTER / RECEIPT #{order.id.toString().padStart(4, "0")}</p>
        <h2 id="receipt-title">Sale complete</h2>
        <p className="muted">{new Date(order.created_at).toLocaleString()}</p>
        <div className="receipt-lines">
          {order.items.map((item) => (
            <div className="receipt-line" key={item.product_id}>
              <span>{item.quantity} x {item.name}<small>{money(item.unit_price_cents)} each</small></span>
              <strong>{money(item.quantity * item.unit_price_cents)}</strong>
            </div>
          ))}
        </div>
        <div className="total-line"><span>Total</span><strong>{money(order.total_cents)}</strong></div>
        <p className="muted">Payment recorded: {order.payment_method}. No payment was processed.</p>
        <button ref={closeButton} className="button primary full" onClick={onClose}>Back to counter</button>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("Register");
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All items");
  const [payment, setPayment] = useState("cash");
  const [receipt, setReceipt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const checkoutKey = useRef(null);
  const closeReceipt = useCallback(() => setReceipt(null), []);

  const refresh = useCallback(async () => {
    const [catalog, history] = await Promise.all([api("/products"), api("/orders")]);
    setProducts(catalog);
    setOrders(history);
  }, []);

  useEffect(() => {
    let active = true;
    refresh().catch((error) => {
      if (active) setError(`Could not load the counter. ${error.message}`);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);

  const categories = ["All items", ...new Set(products.map((product) => product.category))];
  const visible = products.filter((product) =>
    (category === "All items" || product.category === category) &&
    `${product.name} ${product.sku}`.toLowerCase().includes(search.toLowerCase()),
  );
  const cartItems = cart.map((item) => ({
    ...products.find((product) => product.id === item.product_id),
    quantity: item.quantity,
  }));
  const total = cartItems.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  function changeQuantity(product, delta) {
    checkoutKey.current = null;
    setCart((current) => {
      const quantity = (current.find((item) => item.product_id === product.id)?.quantity || 0) + delta;
      if (delta > 0 && (quantity > product.stock || quantity > 10000)) return current;
      const rest = current.filter((item) => item.product_id !== product.id);
      if (quantity <= 0) return rest;
      return [...rest, { product_id: product.id, quantity }];
    });
  }

  async function completeSale() {
    setBusy(true);
    setError("");
    let completed;
    try {
      checkoutKey.current ||= crypto.randomUUID();
      completed = await api("/orders", {
        method: "POST",
        body: JSON.stringify({ items: cart, payment_method: payment, idempotency_key: checkoutKey.current }),
      });
    } catch (error) {
      setError(`Sale not confirmed. ${error.message} Retry the unchanged cart safely, or check Receipts before changing it.`);
      setBusy(false);
      return;
    }
    setReceipt(completed);
    setCart([]);
    checkoutKey.current = null;
    try {
      await refresh();
    } catch (error) {
      setError(`Sale #${completed.id} was saved, but the catalog could not refresh. ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveProduct(product) {
    setBusy(true);
    setError("");
    try {
      const created = await api("/products", { method: "POST", body: JSON.stringify(product) });
      setProducts((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveStock(id, stock) {
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/products/${id}/stock`, { method: "PATCH", body: JSON.stringify({ stock }) });
      setProducts((current) => current.map((product) => product.id === id ? updated : product));
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="./"><span className="brand-mark">c.</span><span>counter<span className="brand-dot">.</span></span></a>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {["Register", "Inventory", "Receipts"].map((tab, index) => (
            <button key={tab} className={`nav-item ${view === tab ? "active" : ""}`}
              aria-current={view === tab ? "page" : undefined} disabled={busy}
              onClick={() => setView(tab)}>
              <span className="nav-number" aria-hidden="true">0{index + 1}</span>{tab}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="store-icon">CC</div>
          <div><strong>Corner Cafe</strong><small>Demo workspace / USD</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar"><span>Corner Cafe <span className="slash">/</span> {view}</span><span className="demo-badge"><span /> LOCAL DEMO</span></header>
        <div className="workspace">
          <div className="page-heading">
            <div><p className="eyebrow">A LITTLE LESS ADMIN. A LITTLE MORE COFFEE.</p><h1>{view === "Register" ? "Let's make someone's day." : view === "Inventory" ? "Everything on the shelf." : "Every sale, accounted for."}</h1>
              <p className="muted">{view === "Register" ? "Good things start at the counter. What are we serving?" : view === "Inventory" ? "Add products and keep your stock levels up to date." : "Your latest 50 sales. Select a receipt to see the details."}</p></div>
            <div className="date-chip">{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          </div>

          {error && <div role="alert" className="error-banner"><span>{error}</span><button className="button secondary small" disabled={busy} onClick={async () => {
            setLoading(true);
            try { await refresh(); setError(""); }
            catch (error) { setError(error.message); }
            finally { setLoading(false); }
          }}>Refresh data</button></div>}

          {loading ? <div className="empty panel" role="status">Getting the counter ready...</div> : (
            <>
              {view === "Register" && <div className="register-layout">
                <section aria-label="Product catalog">
                  <div className="catalog-toolbar">
                    <h2>The menu <span className="count-badge">{products.length}</span></h2>
                    <label className="search"><span className="sr-only">Search products</span><input type="search" placeholder="Search name or SKU..." value={search} onChange={(event) => setSearch(event.target.value)} /></label>
                  </div>
                  <div className="category-tabs" aria-label="Product categories">
                    {categories.map((name) => <button key={name} aria-pressed={category === name} className={category === name ? "selected" : ""} onClick={() => setCategory(name)}>{name}</button>)}
                  </div>
                  <div className="product-grid">
                    {visible.map((product) => {
                      const quantity = cart.find((item) => item.product_id === product.id)?.quantity || 0;
                      return <button className="product-card" key={product.id}
                        disabled={busy || quantity >= product.stock || quantity >= 10000}
                        onClick={() => changeQuantity(product, 1)}
                        aria-label={`Add ${product.name} to cart`}>
                        <div className={`product-art art-${product.category.toLowerCase().replace(/[^a-z]/g, "")}`}>
                          <span className="product-monogram">{categoryMark[product.category] || product.category.slice(0, 2).toUpperCase()}</span>
                          <span className={`stock-badge ${product.stock <= 5 ? "low" : ""}`}>{product.stock === 0 ? "Sold out" : `${product.stock} in stock`}</span>
                        </div>
                        <div className="product-info"><small>{product.category}</small><h3>{product.name}</h3><div><strong>{money(product.price_cents)}</strong><span className="add-mark" aria-hidden="true">+</span></div></div>
                      </button>;
                    })}
                  </div>
                  {visible.length === 0 && <div className="empty panel">No products found. Try another search or add one in Inventory.</div>}
                  <p className="catalog-footnote">Made for the everyday hustle. One good sale at a time.</p>
                </section>

                <aside className="cart panel" aria-label="Current order">
                  <div className="cart-heading"><div><p className="eyebrow">AT THE COUNTER</p><h2>Current order</h2></div><span className="count-badge">{itemCount}</span></div>
                  <div className="cart-items">
                    {cartItems.length === 0 ? <div className="empty-cart"><span className="bag-mark" aria-hidden="true">+</span><h3>A fresh start.</h3><p>Tap something from the menu<br />to start an order.</p></div> : cartItems.map((item) => (
                      <div className="cart-item" key={item.id}>
                        <div className="cart-item-top"><strong>{item.name}</strong><strong>{money(item.quantity * item.price_cents)}</strong></div>
                        <div className="cart-item-bottom"><span>{money(item.price_cents)} each</span><div className="quantity-control">
                          <button disabled={busy} aria-label={`Remove one ${item.name}`} onClick={() => changeQuantity(item, -1)}>-</button>
                          <span>{item.quantity}</span>
                          <button disabled={busy || item.quantity >= item.stock || item.quantity >= 10000} aria-label={`Add one ${item.name}`} onClick={() => changeQuantity(item, 1)}>+</button>
                        </div></div>
                      </div>
                    ))}
                  </div>
                  <div className="cart-summary">
                    <div className="summary-line"><span>Subtotal</span><span>{money(total)}</span></div>
                    <div className="summary-line"><span>Tax</span><span>Not configured</span></div>
                    <div className="total-line"><span>Total</span><strong>{money(total)}</strong></div>
                    {cartItems.some((item) => item.quantity > item.stock) && <p role="status" className="stock-warning">Stock has changed. Reduce the quantities in this order before checking out.</p>}
                    <fieldset disabled={busy}><legend>Record payment method</legend><div className="payment-options">
                      {["cash", "card"].map((method) => <label key={method} className={payment === method ? "chosen" : ""}><input type="radio" name="payment" value={method} checked={payment === method} onChange={() => { setPayment(method); checkoutKey.current = null; }} />{method === "cash" ? "Cash" : "Card"}</label>)}
                    </div></fieldset>
                    <button className="button primary full checkout" disabled={busy || cart.length === 0 || cartItems.some((item) => item.quantity > item.stock)}
                      onClick={completeSale}>{busy ? "Saving sale..." : `Complete sale - ${money(total)}`}</button>
                    <p className="cart-disclaimer">Demo only. No real payment is processed.</p>
                    {cart.length > 0 && <button className="clear-cart" disabled={busy} onClick={() => { setCart([]); checkoutKey.current = null; }}>Clear order</button>}
                  </div>
                </aside>
              </div>}

              {view === "Inventory" && <div className="inventory-layout">
                <section className="panel table-panel"><div className="section-heading"><h2>Product inventory</h2><span className="count-badge">{products.length}</span></div>
                  <div className="table-scroll"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock on hand</th></tr></thead>
                    <tbody>{products.map((product) => <tr key={product.id}><td><strong>{product.name}</strong><small>{product.sku}</small></td><td>{product.category}</td><td>{money(product.price_cents)}</td><td><StockEditor product={product} onSave={saveStock} disabled={busy} /></td></tr>)}</tbody>
                  </table></div>
                </section><ProductForm onSave={saveProduct} disabled={busy} />
              </div>}

              {view === "Receipts" && <section className="panel table-panel">
                <div className="section-heading"><h2>Recent sales</h2><span className="muted">{orders.length} receipts</span></div>
                {orders.length === 0 ? <div className="empty">Your first sale belongs here. Head to the register to get started.</div> :
                  <div className="table-scroll"><table><thead><tr><th>Receipt</th><th>Date</th><th>Items</th><th>Payment</th><th>Total</th><th>Details</th></tr></thead>
                    <tbody>{orders.map((order) => <tr key={order.id}><td><strong>#{order.id.toString().padStart(4, "0")}</strong></td><td>{new Date(order.created_at).toLocaleString()}</td><td>{order.items.reduce((sum, item) => sum + item.quantity, 0)}</td><td className="capitalize">{order.payment_method}</td><td><strong>{money(order.total_cents)}</strong></td><td><button className="button secondary small" onClick={() => setReceipt(order)}>View receipt</button></td></tr>)}</tbody>
                  </table></div>}
              </section>}
            </>
          )}
          <footer>COUNTER POS <span>Small business. Big possibilities.</span><a href="/docs" target="_blank" rel="noreferrer">API docs</a></footer>
        </div>
      </main>
      {receipt && <Receipt order={receipt} onClose={closeReceipt} />}
    </div>
  );
}
