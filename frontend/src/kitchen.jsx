import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export const statusLabels = {
  placed: "Order placed",
  accepted: "Order accepted",
  preparing: "Order preparing",
  ready: "Ready to serve. Please collect your order.",
  collected: "Order collected",
  cancelled: "Order cancelled",
};

const nextSteps = {
  placed: { status: "accepted", label: "Accept order" },
  accepted: { status: "preparing", label: "Start preparing" },
  preparing: { status: "ready", label: "Ready to collect" },
  ready: { status: "collected", label: "Mark collected" },
};

export function OrderProgress({ order }) {
  const stages = ["placed", "accepted", "preparing", "ready", "collected"];
  const position = stages.indexOf(order.kitchen_status);
  return <section className="order-progress" aria-label="Order progress">
    <p className="progress-current">{statusLabels[order.kitchen_status]}</p>
    {order.status !== "cancelled" && <ol className="progress-steps">
      {stages.map((stage, index) => <li key={stage} className={index <= position ? "reached" : ""}
        aria-current={index === position ? "step" : undefined}>{stage === "ready" ? "Ready to collect" : stage}</li>)}
    </ol>}
    {order.progress.length > 0 && <details>
      <summary>Status history</summary>
      <ol className="progress-history">{order.progress.map((event) => <li key={event.id}>
        <span>{statusLabels[event.status]}</span><time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time>
      </li>)}</ol>
    </details>}
  </section>;
}

export function OrderNotifications({ onUpdate, onUnauthorized }) {
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState("");
  const callbacks = useRef({ onUpdate, onUnauthorized });
  callbacks.current = { onUpdate, onUnauthorized };

  useEffect(() => {
    let active = true;
    let timer;
    let cursor = null;
    const controller = new AbortController();
    async function poll() {
      let delay = 3000;
      let unauthorized = false;
      try {
        const feed = await api(`/kitchen/updates${cursor === null ? "" : `?after_id=${cursor}`}`, { signal: controller.signal });
        if (!active) return;
        if (feed.events.length) {
          setNotifications((current) => [...feed.events.slice().reverse(), ...current].slice(0, 10));
        }
        if (cursor === null || feed.events.length) callbacks.current.onUpdate(feed.events);
        cursor = feed.cursor;
        setError("");
        if (feed.has_more) delay = 0;
      } catch (error) {
        if (!active) return;
        if (error.status === 401) {
          unauthorized = true;
          callbacks.current.onUnauthorized(error);
        } else {
          setError(`Live order updates are unavailable. ${error.message} Retrying automatically.`);
        }
      } finally {
        if (active && !unauthorized) timer = setTimeout(poll, delay);
      }
    }
    poll();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, []);

  return <section aria-label="Order notifications">
    {error && <div role="alert" className="error-banner">{error}</div>}
    <div role="status" aria-live="polite" aria-atomic="false" className="order-notifications">
      {notifications.map((event) => <div key={event.id} className={`order-notification notification-${event.status}`}>
        <div><strong>Order #{event.order_id}</strong><p>{statusLabels[event.status]}</p></div>
        <button className="button secondary small" aria-label={`Dismiss update ${event.id}`}
          onClick={() => setNotifications((current) => current.filter((item) => item.id !== event.id))}>Dismiss</button>
      </div>)}
    </div>
  </section>;
}

export default function Kitchen({ onUnauthorized }) {
  const [orders, setOrders] = useState([]);
  const [view, setView] = useState("active");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(null);
  const sequence = useRef(0);
  const changing = useRef(false);

  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();
    setLoading(true);
    async function poll() {
      let unauthorized = false;
      if (changing.current) { timer = setTimeout(poll, 3000); return; }
      const request = ++sequence.current;
      try {
        const rows = await api(`/kitchen/orders?view=${view}&limit=50&offset=${offset}`, { signal: controller.signal });
        if (!active || request !== sequence.current) return;
        setOrders(rows);
        setUpdatedAt(new Date());
        setError("");
      } catch (error) {
        if (!active || request !== sequence.current) return;
        if (error.status === 401) { unauthorized = true; onUnauthorized(error); }
        else setError(`Kitchen updates are unavailable. ${error.message} Retrying automatically.`);
      } finally {
        if (active) {
          setLoading(false);
          if (!unauthorized) timer = setTimeout(poll, 3000);
        }
      }
    }
    poll();
    return () => { active = false; sequence.current += 1; controller.abort(); clearTimeout(timer); };
  }, [view, offset, onUnauthorized]);

  async function advance(order) {
    changing.current = true;
    sequence.current += 1;
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/kitchen/orders/${order.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextSteps[order.kitchen_status].status, expected_version: order.version }),
      });
      sequence.current += 1;
      setOrders((current) => current.map((item) => item.id === updated.id ? updated : item)
        .filter((item) => item.kitchen_status !== "collected" && item.status !== "cancelled"));
    } catch (error) {
      if (error.status === 401) onUnauthorized(error);
      else setError(`${error.message} The queue refreshes automatically; review it before retrying.`);
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }

  return <section aria-label="Kitchen orders">
    <div className="section-heading kitchen-toolbar">
      <div className="row-actions">
        <button className={`button ${view === "active" ? "primary" : "secondary"}`} disabled={busy}
          aria-pressed={view === "active"} onClick={() => { setView("active"); setOffset(0); }}>Active orders</button>
        <button className={`button ${view === "history" ? "primary" : "secondary"}`} disabled={busy}
          aria-pressed={view === "history"} onClick={() => { setView("history"); setOffset(0); }}>Kitchen history</button>
      </div>
      <p className="muted">Updates every 3 seconds{updatedAt && ` / Last updated ${updatedAt.toLocaleTimeString()}`}</p>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {loading ? <p className="empty panel" role="status">Loading kitchen orders...</p> :
      <div className="kitchen-grid">{orders.map((order) => {
        const next = nextSteps[order.kitchen_status];
        return <article className={`panel kitchen-ticket ticket-${order.kitchen_status}`} key={order.id}>
          <div className="section-heading"><h2>Order #{order.id}</h2><span className={`status-badge ${order.kitchen_status}`}>{order.kitchen_status}</span></div>
          <p className="muted">{order.customer_name || "Legacy order"} / {new Date(order.created_at).toLocaleString()}</p>
          <ul className="kitchen-items">{order.items.map((item) => <li key={item.product_id}><strong>{item.quantity} x</strong> {item.name}</li>)}</ul>
          <OrderProgress order={order} />
          {view === "active" && next && order.status !== "cancelled" && <button className="button primary full" disabled={busy}
            aria-label={`${next.label} #${order.id}`} onClick={() => advance(order)}>{busy ? "Updating..." : next.label}</button>}
        </article>;
      })}</div>}
    {!loading && orders.length === 0 && <p className="empty panel">{view === "active" ? "No active orders. New orders will appear automatically." : "No collected or cancelled orders yet."}</p>}
    <div className="pagination">
      <button className="button secondary small" disabled={busy || loading || offset === 0} onClick={() => setOffset(offset - 50)}>Previous</button>
      <span>Page {offset / 50 + 1}</span>
      <button className="button secondary small" disabled={busy || loading || orders.length < 50} onClick={() => setOffset(offset + 50)}>Next</button>
    </div>
  </section>;
}

