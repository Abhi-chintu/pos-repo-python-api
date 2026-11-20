import { useEffect, useRef, useState } from "react";
import { api, money } from "./api.js";

export function Dialog({ title, children, onClose, busy = false }) {
  const dialog = useRef(null);
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => [...dialog.current.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]")];
    focusable()[0]?.focus();
    const keydown = (event) => {
      if (event.key === "Escape" && !latest.current.busy) latest.current.onClose();
      if (event.key === "Tab") {
        const elements = focusable();
        if (elements.length === 0) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === elements[0]) {
          event.preventDefault();
          elements.at(-1).focus();
        } else if (!event.shiftKey && document.activeElement === elements.at(-1)) {
          event.preventDefault();
          elements[0].focus();
        }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onClick={(event) => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={dialog} className="receipt panel" role="dialog" aria-modal="true" aria-label={title}>
      {children}
    </section>
  </div>;
}

export function ConfirmationDialog({ title, message, confirmLabel, onConfirm, onClose, onUnauthorized }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      if (error.status === 401) onUnauthorized(error);
      else setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={title} busy={busy} onClose={onClose}>
    <h2>{title}</h2>
    <p className="muted">{message}</p>
    {error && <div role="alert" className="error-banner">{error}</div>}
    <div className="stack-form">
      <button className="button secondary" disabled={busy} onClick={onClose}>Go back</button>
      <button className="button danger" disabled={busy} onClick={confirm}>{busy ? "Working..." : confirmLabel}</button>
    </div>
  </Dialog>;
}

export function OrderEditor({ order, products, onSaved, onClose, onUnauthorized }) {
  const [lines, setLines] = useState(order.items.map((item) => ({ ...item })));
  const [payment, setPayment] = useState(order.payment_method);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const candidates = products.filter((product) => !lines.some((line) => line.product_id === product.id));
  const total = lines.reduce((sum, line) => sum + Number(line.quantity) * line.unit_price_cents, 0);

  async function submit(event) {
    event.preventDefault();
    const items = lines.filter((line) => Number(line.quantity) > 0)
      .map((line) => ({ product_id: line.product_id, quantity: Number(line.quantity) }));
    if (!items.length) { setError("Keep at least one item, or cancel the order instead."); return; }
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/orders/${order.id}`, {
        method: "PUT",
        body: JSON.stringify({ expected_version: order.version, payment_method: payment, items }),
      });
      onSaved(updated);
    } catch (error) {
      if (error.status === 401) onUnauthorized(error);
      else setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={`Edit order #${order.id}`} busy={busy} onClose={onClose}>
    <h2>Edit order #{order.id}</h2>
    <p className="muted">Existing items retain their recorded prices. Added products use current prices. Set a quantity to zero to remove a line.</p>
    {error && <div role="alert" className="error-banner">{error}</div>}
    <form className="stack-form" onSubmit={submit}>
      {lines.map((line) => <label key={line.product_id} className="order-edit-line">
        <span>{line.name}<small>{money(line.unit_price_cents)} each</small></span>
        <input aria-label={`Quantity for ${line.name}`} type="number" min="0" max="10000" required disabled={busy}
          value={line.quantity} onChange={(event) => setLines((current) => current.map((item) => item.product_id === line.product_id ? { ...item, quantity: event.target.value } : item))} />
      </label>)}
      <label>Add another product<select value="" disabled={busy} onChange={(event) => {
        const product = products.find((item) => item.id === Number(event.target.value));
        if (product) setLines((current) => [...current, {
          product_id: product.id, name: product.name, quantity: 1, unit_price_cents: product.price_cents,
        }]);
      }}><option value="">Select a product</option>{candidates.map((product) => <option key={product.id} value={product.id}>{product.name} ({product.stock} in stock)</option>)}</select></label>
      <label>Payment method<select value={payment} disabled={busy} onChange={(event) => setPayment(event.target.value)}>
        <option value="cash">Cash</option><option value="card">Card</option>
      </select></label>
      <div className="total-line"><span>Updated total</span><strong>{money(total)}</strong></div>
      <button className="button primary" disabled={busy}>{busy ? "Saving..." : "Save order changes"}</button>
      <button type="button" className="button secondary" disabled={busy} onClick={onClose}>Close without saving</button>
    </form>
  </Dialog>;
}

export function UsersPanel({ currentUser, onSelfChanged, onUnauthorized }) {
  const [users, setUsers] = useState([]);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(null);
  const [formKey, setFormKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [deactivating, setDeactivating] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api(`/users?limit=100&offset=${offset}`).then((rows) => { if (active) setUsers(rows); })
      .catch((error) => { if (active) { setError(error.message); if (error.status === 401) onUnauthorized(error); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [offset, revision, onUnauthorized]);

  async function save(event) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    if (editing) fields.active = fields.active === "true";
    if (!fields.password) delete fields.password;
    setBusy(true);
    setError("");
    let saved;
    try {
      saved = await api(editing ? `/users/${editing.id}` : "/users", {
        method: editing ? "PUT" : "POST", body: JSON.stringify(fields),
      });
    } catch (error) {
      setError(error.message);
      if (error.status === 401) onUnauthorized(error);
      setBusy(false);
      return;
    }
    if (saved.id === currentUser.id) { onSelfChanged(); return; }
    setEditing(null);
    setFormKey((key) => key + 1);
    try {
      setUsers(await api(`/users?limit=100&offset=${offset}`));
    } catch (error) {
      setError(`User saved, but the list could not refresh. ${error.message}`);
      if (error.status === 401) onUnauthorized(error);
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(user) {
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/users/${user.id}`, { method: "DELETE" });
      if (updated.id === currentUser.id) { onSelfChanged(); return; }
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (editing?.id === updated.id) {
        setEditing(null);
        setFormKey((key) => key + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return <div>
    {error && <div role="alert" className="error-banner"><span>{error}</span><button className="button secondary small" disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>Reload users</button></div>}
    <div className="inventory-layout">
      <section className="panel table-panel">
        <div className="section-heading"><h2>User accounts</h2><span className="muted">Changes revoke existing sessions.</span></div>
        {loading ? <p className="empty" role="status">Loading users...</p> : <div className="table-scroll">
          <table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{users.map((user) => <tr key={user.id}>
              <td><strong>{user.name}</strong><small>{user.email}</small></td>
              <td className="capitalize">{user.role}</td><td>{user.active ? "Active" : "Inactive"}</td>
              <td><div className="row-actions">
                <button className="button secondary small" disabled={busy} onClick={() => { setEditing(user); setFormKey((key) => key + 1); }}>Edit</button>
                <button className="button danger small" disabled={busy || !user.active} onClick={() => setDeactivating(user)}>Delete</button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>}
        <div className="pagination">
          <button className="button secondary small" disabled={busy || loading || offset === 0} onClick={() => setOffset(offset - 100)}>Previous</button>
          <span>Page {offset / 100 + 1}</span>
          <button className="button secondary small" disabled={busy || loading || users.length < 100} onClick={() => setOffset(offset + 100)}>Next</button>
        </div>
      </section>
      <form className="panel product-form" key={formKey} onSubmit={save}>
        <h2>{editing ? "Edit user" : "Create user"}</h2>
        <label>Name<input name="name" required maxLength="100" defaultValue={editing?.name || ""} disabled={busy} /></label>
        <label>Email<input name="email" type="email" required maxLength="254" defaultValue={editing?.email || ""} disabled={busy} /></label>
        <label>{editing ? "New password (optional)" : "Password"}<input name="password" type="password" minLength="8" maxLength="128" required={!editing} autoComplete="new-password" disabled={busy} /></label>
        <label>Role<select name="role" defaultValue={editing?.role || "customer"} disabled={busy}><option value="customer">Customer</option><option value="kitchen">Kitchen</option><option value="admin">Admin</option></select></label>
        {editing && <label>Status<select name="active" defaultValue={String(editing.active)} disabled={busy}><option value="true">Active</option><option value="false">Inactive</option></select></label>}
        <button className="button primary" disabled={busy}>{busy ? "Saving..." : editing ? "Save user" : "Create user"}</button>
        {editing && <button className="button secondary" type="button" disabled={busy} onClick={() => { setEditing(null); setFormKey((key) => key + 1); }}>Cancel edit</button>}
      </form>
    </div>
    {deactivating && <ConfirmationDialog title="Delete user?"
      message={`Delete ${deactivating.email}? This deactivates the account and signs the user out. Existing orders and receipts are kept.`}
      confirmLabel="Delete user" onConfirm={() => deactivate(deactivating)}
      onClose={() => setDeactivating(null)} onUnauthorized={onUnauthorized} />}
  </div>;
}

