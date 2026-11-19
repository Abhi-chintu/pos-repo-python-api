export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const message = Array.isArray(detail)
      ? detail.map((error) => `${error.loc.slice(1).join(".")}: ${error.msg}`).join("; ")
      : detail;
    throw new Error(message || `Request failed (${response.status}). Please try again.`);
  }
  return response.json();
}

export const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
