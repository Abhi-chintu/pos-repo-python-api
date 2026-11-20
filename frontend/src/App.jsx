import { useCallback, useEffect, useRef, useState } from "react";
import { api, createCheckoutKey, money } from "./api.js";
import Auth from "./Auth.jsx";
import { ConfirmationDialog, Dialog, OrderEditor, UsersPanel } from "./AdminPanels.jsx";
import Kitchen, { OrderNotifications, OrderProgress, statusLabels } from "./Kitchen.jsx";
import CategorySelect from "./CategorySelect.jsx";

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

function ProductForm({ onSave, disabled, product, onCancel, categories }) {
  const [category, setCategory] = useState(product?.category || "");
  return (
    <form className="product-form panel" onSubmit={async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const { price, ...values } = Object.fromEntries(new FormData(form));
      const selectedCategory = categories.find((name) => name.toLowerCase() === category.trim().toLowerCase());
      const saved = await onSave({
        ...values,
        category: selectedCategory || category.trim(),
        price_cents: Math.round(Number(price) * 100),
        ...(!product && { stock: Number(values.stock) }),
      });
      if (saved) { form.reset(); setCategory(""); }
    }}>
      <div><p className="eyebrow">MANAGE YOUR CATALOG</p><h2>{product ? "Edit product" : "Add a product"}</h2></div>
      <label>Product name<input name="name" required maxLength="100" defaultValue={product?.name || ""} placeholder="Oat milk latte" /></label>
      <label>SKU<input name="sku" required maxLength="40" defaultValue={product?.sku || ""} pattern={"[A-Za-z0-9_\\-]+"} placeholder="COF-004" /></label>
      <CategorySelect categories={categories} value={category} onChange={setCategory} disabled={disabled} />
      <div className="form-row">
        <label>Price (USD)<input name="price" type="number" min="0.01" max="1000000" step="0.01" required defaultValue={product ? (product.price_cents / 100).toFixed(2) : ""} placeholder="4.50" /></label>
        {!product && <label>Opening stock<input name="stock" type="number" min="0" max="1000000" required defaultValue="0" /></label>}
      </div>
      {product && <p className="muted">Use the inventory table to set stock counts. Editing product details does not reset stock.</p>}
      <button className="button primary" disabled={disabled}>{product ? "Save product" : "Add product"}</button>
      {product && <button className="button secondary" type="button" disabled={disabled} onClick={onCancel}>Cancel edit</button>}
    </form>
  );
}

function Receipt({ order, onClose }) {
  return (
    <Dialog title={`Receipt #${order.id}`} onClose={onClose}>
        <div className="success-mark" aria-hidden="true">{order.status === "cancelled" ? "X" : "OK"}</div>
        <p className="eyebrow">COUNTER / RECEIPT #{order.id.toString().padStart(4, "0")}</p>
        <h2 id="receipt-title">{order.status === "cancelled" ? "Order cancelled" : "Sale complete"}</h2>
        <p className="muted">{new Date(order.created_at).toLocaleString()}</p>
        <p className="muted">{order.customer_name || "Legacy order"}{order.customer_email ? ` / ${order.customer_email}` : ""}</p>
        <OrderProgress order={order} />
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
        <button className="button primary full" onClick={onClose}>Back to counter</button>
    </Dialog>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [sessionError, setSessionError] = useState("");

  const endSession = useCallback((message = "") => {
    setUser(null);
    setSessionError(message);
  }, []);
  if (!user) return <Auth key={sessionError} initialError={sessionError} onAuthenticated={(account) => { setSessionError(""); setUser(account); }} />;
  return <Workspace key={user.id} user={user} endSession={endSession} />;
}

function Workspace({ user, endSession }) {
  const isAdmin = user.role === "admin";
  const isKitchen = user.role === "kitchen";
  const [view, setView] = useState(isKitchen ? "Kitchen" : "Register");
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
  const [editingProduct, setEditingProduct] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [productStatus, setProductStatus] = useState("active");
  const [inventoryCategory, setInventoryCategory] = useState("");
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState("");
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customersError, setCustomersError] = useState("");
  const [customerRevision, setCustomerRevision] = useState(0);
  const [orderOffset, setOrderOffset] = useState(0);
  const checkoutKey = useRef(null);
  const refreshSequence = useRef(0);
  const closeReceipt = useCallback(() => setReceipt(null), []);
  const reportError = useCallback((error) => {
    if (error.status === 401) endSession("Your session has expired or changed. Please log in again.");
    else setError(error.message);
  }, [endSession]);

  const refresh = useCallback(async () => {
    if (isKitchen) return;
    const sequence = ++refreshSequence.current;
    const [catalog, history] = await Promise.all([
      api(isAdmin ? "/products?include_archived=true" : "/products"),
      api(`/orders?limit=50&offset=${orderOffset}`),
    ]);
    if (sequence !== refreshSequence.current) return;
    setProducts(catalog);
    setOrders(history);
  }, [isAdmin, isKitchen, orderOffset]);

  const trackOrders = useCallback((events) => {
    const update = (order) => events.reduce((current, event) =>
      event.order_id === current.id && event.version > current.version ? {
        ...current, kitchen_status: event.status, version: event.version,
        status: event.status === "cancelled" ? "cancelled" : current.status,
        progress: [...current.progress, event],
      } : current, order);
    setOrders((current) => current.map(update));
    setReceipt((current) => current && update(current));
    refresh().catch(reportError);
  }, [refresh, reportError]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    refresh().catch((error) => {
      if (active) reportError(error);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; refreshSequence.current += 1; };
  }, [refresh, reportError]);

  useEffect(() => {
    if (!isAdmin || view !== "Register") return;
    const controller = new AbortController();
    setCustomersLoading(true);
    setCustomersError("");
    api("/users/customers", { signal: controller.signal }).then((rows) => {
      if (!controller.signal.aborted) setCustomers(rows);
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if (error.status === 401) reportError(error);
      else setCustomersError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setCustomersLoading(false);
    });
    return () => controller.abort();
  }, [isAdmin, view, customerRevision, reportError]);

  const selectedCustomer = customers.find((customer) => String(customer.id) === customerId);
  const customerRequired = isAdmin && (customersLoading || Boolean(customersError) || !selectedCustomer);
  const activeProducts = products.filter((product) => product.active);
  const productCategories = [...new Map(products.map((product) =>
    [product.category.trim().toLowerCase(), product.category.trim()],
  )).values()].sort((left, right) => left.localeCompare(right));
  const categoryFilter = productCategories.some((name) => name.toLowerCase() === inventoryCategory) ? inventoryCategory : "";
  const inventoryProducts = products.filter((product) =>
    (productStatus === "all" || product.active === (productStatus === "active")) &&
    (!categoryFilter || product.category.trim().toLowerCase() === categoryFilter),
  );
  const categories = ["All items", ...new Set(activeProducts.map((product) => product.category))];
  const visible = activeProducts.filter((product) =>
    (category === "All items" || product.category === category) &&
    `${product.name} ${product.sku}`.toLowerCase().includes(search.toLowerCase()),
  );
  const cartItems = cart.map((item) => ({
    ...(activeProducts.find((product) => product.id === item.product_id) || {
      id: item.product_id, name: "Product no longer available", stock: 0, price_cents: 0,
    }),
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
    if (customerRequired) {
      setError("Select an active customer before placing the order.");
      return;
    }
    setBusy(true);
    setError("");
    let completed;
    try {
      checkoutKey.current ||= createCheckoutKey();
      completed = await api("/orders", {
        method: "POST",
        body: JSON.stringify({
          items: cart, payment_method: payment, idempotency_key: checkoutKey.current,
          ...(isAdmin && { customer_id: selectedCustomer.id }),
        }),
      });
    } catch (error) {
      if (error.status === 401) reportError(error);
      else setError(`Sale not confirmed. ${error.message} Retry the unchanged cart safely, or check your orders before changing it.`);
      setBusy(false);
      return;
    }
    setReceipt(completed);
    setCart([]);
    setCustomerId("");
    checkoutKey.current = null;
    try {
      await refresh();
    } catch (error) {
      if (error.status === 401) reportError(error);
      else setError(`Sale #${completed.id} was saved, but the catalog could not refresh. ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveProduct(product) {
    setBusy(true);
    setError("");
    try {
      const saved = await api(editingProduct ? `/products/${editingProduct.id}` : "/products", {
        method: editingProduct ? "PUT" : "POST", body: JSON.stringify(product),
      });
      setProducts((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)));
      setEditingProduct(null);
      return true;
    } catch (error) {
      reportError(error);
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
      reportError(error);
    } finally {
      setBusy(false);
    }
  }

  async function changeProductAvailability(product, restore = false) {
    setBusy(true);
    setError("");
    try {
      const restored = await api(restore ? `/products/${product.id}/restore` : `/products/${product.id}`, {
        method: restore ? "POST" : "DELETE",
      });
      setProducts((current) => current.map((item) => item.id === product.id ? restored || { ...item, active: false } : item));
      if (editingProduct?.id === product.id) setEditingProduct(null);
    } finally { setBusy(false); }
  }

  async function deleteProduct(product) {
    setBusy(true);
    setError("");
    try {
      await api(`/products/${product.id}/permanent`, { method: "DELETE" });
      setProducts((current) => current.filter((item) => item.id !== product.id));
      if (editingProduct?.id === product.id) setEditingProduct(null);
    } finally { setBusy(false); }
  }

  async function orderSaved(updated) {
    setEditingOrder(null);
    setOrders((current) => current.map((order) => order.id === updated.id ? updated : order));
    setBusy(true);
    try { await refresh(); }
    catch (error) {
      if (error.status === 401) reportError(error);
      else setError(`Order #${updated.id} was saved, but data could not refresh. ${error.message}`);
    } finally { setBusy(false); }
  }

  async function cancelOrder(order) {
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/orders/${order.id}/cancel`, {
        method: "POST", body: JSON.stringify({ expected_version: order.version }),
      });
      await orderSaved(updated);
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { await api("/auth/logout", { method: "POST" }); endSession(); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  }

  const tabs = isAdmin ? ["Register", "Inventory", "Receipts", "Kitchen", "Users"] : isKitchen ? ["Kitchen"] : ["Register", "My orders"];
  const isOrdersView = view === "Receipts" || view === "My orders";
  const heading = {
    Register: "Let's make someone's day.", Inventory: "Everything on the shelf.",
    Receipts: "Every sale, accounted for.", "My orders": "Your orders, all in one place.",
    Users: "The people behind the counter.",
    Kitchen: "From the counter to the kitchen.",
  }[view];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="./"><span className="brand-mark">c.</span><span>counter<span className="brand-dot">.</span></span></a>
        <p className="sidebar-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {tabs.map((tab, index) => (
            <button key={tab} className={`nav-item ${view === tab ? "active" : ""}`}
              aria-current={view === tab ? "page" : undefined} disabled={busy}
              onClick={() => { setView(tab); if (tab === "Receipts") refresh().catch(reportError); }}>
              <span className="nav-number" aria-hidden="true">0{index + 1}</span>{tab}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="store-icon">CC</div>
          <div><strong>{user.name}</strong><small>{isAdmin ? "Administrator" : isKitchen ? "Kitchen staff" : "Customer"} / USD</small></div>
        </div>
      </aside>

      <main>
        <header className="topbar"><span>Corner Cafe <span className="slash">/</span> {view}</span><div className="account-menu"><span>{user.email}</span><button className="button primary small" disabled={busy} onClick={logout}>Log out</button></div></header>
        <div className="workspace">
          <div className="page-heading">
            <div><p className="eyebrow">{isAdmin ? "ADMIN WORKSPACE" : isKitchen ? "KITCHEN WORKSPACE" : "YOUR CORNER CAFE"}</p><h1>{heading}</h1>
              <p className="muted">{view === "Register" ? "Edit your cart before placing an order." : view === "Inventory" ? "Manage products and stock. Restore archived products or delete products never ordered." : view === "Kitchen" ? "Accept orders, prepare them and let customers know when to collect." : isOrdersView ? "Live kitchen progress is shown with each receipt." : "Create accounts, edit roles and deactivate users."}</p></div>
            <div className="date-chip">{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          </div>

          {user.role === "customer" && <OrderNotifications onUpdate={trackOrders} onUnauthorized={reportError} />}
          {error && <div role="alert" className="error-banner"><span>{error}</span><button className="button secondary small" disabled={busy || loading} onClick={async () => {
            setLoading(true);
            try { await refresh(); setError(""); }
            catch (error) { reportError(error); }
            finally { setLoading(false); }
          }}>Refresh data</button></div>}

          {loading ? <div className="empty panel" role="status">Getting the counter ready...</div> : (
            <>
              {view === "Register" && <div className="register-layout">
                <section aria-label="Product catalog">
                  <div className="catalog-toolbar">
                    <h2>The menu <span className="count-badge">{activeProducts.length}</span></h2>
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
                  {visible.length === 0 && <div className="empty panel">{isAdmin ? "No products found. Try another search or add one in Inventory." : "No products found. Try another search or check back later."}</div>}
                  <p className="catalog-footnote">Made for the everyday hustle. One good sale at a time.</p>
                </section>

                <aside className="cart panel" aria-label="Current order">
                  <div className="cart-heading"><div><p className="eyebrow">AT THE COUNTER</p><h2>Current order</h2></div><span className="count-badge">{itemCount}</span></div>
                  {isAdmin && <div className="register-customer">
                    <label>Customer<select value={selectedCustomer ? customerId : ""} disabled={busy || customersLoading || !!customersError}
                      onChange={(event) => { setCustomerId(event.target.value); checkoutKey.current = null; }}>
                      <option value="">{customersLoading ? "Loading customers..." : "Select a customer"}</option>
                      {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} ({customer.email})</option>)}
                    </select></label>
                    <button className="button secondary small" disabled={busy || customersLoading}
                      onClick={() => setCustomerRevision((value) => value + 1)}>Reload customers</button>
                    {customersError && <p role="alert" className="error-banner">{customersError}</p>}
                    {!customersLoading && !customersError && customers.length === 0 && <p className="muted">No active customers. Create a customer in Users or ask them to sign up.</p>}
                  </div>}
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
                    <button className="button primary full checkout" disabled={busy || customerRequired || cart.length === 0 || cartItems.some((item) => item.quantity > item.stock)}
                      onClick={completeSale}>{busy ? "Saving sale..." : `Complete sale - ${money(total)}`}</button>
                    <p className="cart-disclaimer">Demo only. No real payment is processed.</p>
                    {cart.length > 0 && <button className="clear-cart" disabled={busy} onClick={() => { setCart([]); checkoutKey.current = null; }}>Clear order</button>}
                  </div>
                </aside>
              </div>}

              {isAdmin && view === "Inventory" && <div className="inventory-layout">
                <section className="panel table-panel"><div className="section-heading inventory-filters"><h2>Product inventory</h2><span className="count-badge">{inventoryProducts.length}</span>
                  <label>Product status <select value={productStatus} disabled={busy} onChange={(event) => setProductStatus(event.target.value)}>
                    <option value="active">Active</option><option value="archived">Archived</option><option value="all">All products</option>
                  </select></label>
                  <label>Filter by category <select value={categoryFilter} disabled={busy} onChange={(event) => setInventoryCategory(event.target.value)}>
                    <option value="">All categories</option>
                    {productCategories.map((name) => <option key={name} value={name.toLowerCase()}>{name}</option>)}
                  </select></label>
                </div>
                  <div className="table-scroll"><table><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Status</th><th>Stock on hand</th><th>Actions</th></tr></thead>
                    <tbody>{inventoryProducts.map((product) => <tr key={product.id}>
                      <td><strong>{product.name}</strong><small>{product.sku}</small></td><td>{product.category}</td><td>{money(product.price_cents)}</td>
                      <td>{product.active ? "Active" : "Archived"}</td>
                      <td>{product.active ? <StockEditor product={product} onSave={saveStock} disabled={busy} /> : product.stock}</td>
                      <td><div className="row-actions">
                        {product.active && <button className="button secondary small" disabled={busy} onClick={() => setEditingProduct(product)}>Edit</button>}
                        <button className="button secondary small" disabled={busy} onClick={() => setConfirmation({
                          title: product.active ? "Archive product?" : "Restore product?",
                          message: product.active ? `Archive ${product.name}? It will leave the menu, but receipts and stock will be kept.` : `Restore ${product.name}? It will return to the menu with its current price and stock.`,
                          confirmLabel: product.active ? "Archive product" : "Restore product",
                          onConfirm: () => changeProductAvailability(product, !product.active),
                        })}>{product.active ? "Archive" : "Restore"}</button>
                        <button className="button danger small" disabled={busy} onClick={() => setConfirmation({
                          title: "Delete product permanently?",
                          message: `Delete ${product.name}? This cannot be undone. Products that have been ordered must be archived instead.`,
                          confirmLabel: "Delete permanently", onConfirm: () => deleteProduct(product),
                        })}>Delete</button>
                      </div></td>
                    </tr>)}</tbody>
                  </table></div>
                  {inventoryProducts.length === 0 && <p className="empty">No products match the selected filters.</p>}
                </section><ProductForm key={editingProduct?.id ?? "new"} product={editingProduct} categories={productCategories} onCancel={() => setEditingProduct(null)} onSave={saveProduct} disabled={busy} />
              </div>}

              {isOrdersView && <section className="panel table-panel">
                <div className="section-heading"><h2>{isAdmin ? "All orders" : "My orders"}</h2><span className="muted">{isAdmin ? "Edit before acceptance; cancel before collection." : "Progress updates automatically while this app is open."}</span></div>
                {orders.length === 0 ? <div className="empty">Your first sale belongs here. Head to the register to get started.</div> :
                  <div className="table-scroll"><table><thead><tr><th>Receipt</th><th>Date</th>{isAdmin && <th>Customer</th>}<th>Status</th><th>Items</th><th>Payment</th><th>Total</th><th>Actions</th></tr></thead>
                    <tbody>{orders.map((order) => <tr key={order.id}><td><strong>#{order.id.toString().padStart(4, "0")}</strong></td><td>{new Date(order.created_at).toLocaleString()}</td>{isAdmin && <td>{order.customer_name || "Legacy order"}<small>{order.customer_email}</small></td>}<td><span className={`status-badge ${order.kitchen_status}`}>{statusLabels[order.kitchen_status]}</span></td><td>{order.items.reduce((sum, item) => sum + item.quantity, 0)}</td><td className="capitalize">{order.payment_method}</td><td><strong>{money(order.total_cents)}</strong></td><td><div className="row-actions"><button className="button secondary small" disabled={busy} onClick={() => setReceipt(order)}>View receipt</button>{isAdmin && order.status === "placed" && order.kitchen_status !== "collected" && <>{order.kitchen_status === "placed" && <button className="button secondary small" disabled={busy} onClick={() => setEditingOrder(order)}>Edit order</button>}<button className="button danger small" disabled={busy} onClick={() => setConfirmation({
                      title: "Cancel order?", message: `Cancel order #${order.id} and restore its stock? No payment refund will be processed.`,
                      confirmLabel: "Cancel order", onConfirm: () => cancelOrder(order),
                    })}>Cancel order</button></>}</div></td></tr>)}</tbody>
                  </table></div>}
                <div className="pagination"><button className="button secondary small" disabled={busy || orderOffset === 0} onClick={() => setOrderOffset(orderOffset - 50)}>Previous</button><span>Page {orderOffset / 50 + 1}</span><button className="button secondary small" disabled={busy || orders.length < 50} onClick={() => setOrderOffset(orderOffset + 50)}>Next</button></div>
              </section>}
              {(isAdmin || isKitchen) && view === "Kitchen" && <Kitchen onUnauthorized={reportError} />}
              {isAdmin && view === "Users" && <UsersPanel currentUser={user} onSelfChanged={() => endSession("Your account was updated. Please log in again.")} onUnauthorized={reportError} />}
            </>
          )}
          <footer>COUNTER POS <span>Small business. Big possibilities.</span><a href="/api/orders/docs" target="_blank" rel="noreferrer">Order API</a>{!isKitchen && <a href="/api/products/docs" target="_blank" rel="noreferrer">Product API</a>}{(isAdmin || isKitchen) && <a href="/api/kitchen/docs" target="_blank" rel="noreferrer">Kitchen API</a>}<a href="/api/auth/docs" target="_blank" rel="noreferrer">Auth API</a></footer>
        </div>
      </main>
      {receipt && <Receipt order={receipt} onClose={closeReceipt} />}
      {isAdmin && editingOrder && <OrderEditor order={editingOrder} products={activeProducts} onSaved={orderSaved} onClose={() => setEditingOrder(null)} onUnauthorized={reportError} />}
      {confirmation && <ConfirmationDialog {...confirmation} onClose={() => setConfirmation(null)} onUnauthorized={reportError} />}
    </div>
  );
}

