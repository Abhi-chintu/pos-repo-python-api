import json
from typing import Annotated

from fastapi import HTTPException, Query
from pymysql.cursors import DictCursor

from app.database import DatabaseConfig, connect
from app.order_data import lock_progress, read_order, record_progress
from app.schemas import CartItem, Checkout, Order, OrderCancel, OrderUpdate
from app.security import AdminUser, CurrentUser, SalesUser
from app.service import create_service


def replace_items(cursor: DictCursor, order_id: int, items: list[CartItem], previous: list[dict]) -> int:
    old = {item["product_id"]: item for item in previous}
    new = {item.product_id: item.quantity for item in items}
    snapshots = []
    total = 0
    # Lock inventory in a consistent order for checkout, edits and cancellation.
    for product_id in sorted(old.keys() | new.keys()):
        cursor.execute("SELECT * FROM products WHERE id = %s FOR UPDATE", (product_id,))
        product = cursor.fetchone()
        if product is None:
            raise HTTPException(404, f"Product {product_id} not found.")
        previous_quantity = old[product_id]["quantity"] if product_id in old else 0
        quantity = new.get(product_id, 0)
        additional = quantity - previous_quantity
        if additional > 0 and not product["active"]:
            raise HTTPException(409, f"{product['name']} has been archived.")
        if additional > product["stock"]:
            raise HTTPException(409, f"Not enough stock for {product['name']}.")
        if product["stock"] - additional > 1_000_000:
            raise HTTPException(409, f"Restoring {product['name']} would exceed the stock limit. Adjust inventory first.")
        cursor.execute(
            "UPDATE products SET stock = stock - %s, ever_ordered = TRUE WHERE id = %s",
            (additional, product_id),
        )
        if quantity:
            price = old[product_id]["unit_price_cents"] if product_id in old else product["price_cents"]
            name = old[product_id]["name"] if product_id in old else product["name"]
            snapshots.append((order_id, product_id, name, quantity, price))
            total += quantity * price
    cursor.execute("DELETE FROM order_items WHERE order_id = %s", (order_id,))
    if snapshots:
        cursor.executemany(
            """INSERT INTO order_items
               (order_id, product_id, name, quantity, unit_price_cents)
               VALUES (%s, %s, %s, %s, %s)""",
            snapshots,
        )
    return total


def create_app(database_config: DatabaseConfig | None = None):
    app = create_service("Counter Orders", "/api/orders", database_config)

    @app.post("/api/orders", response_model=Order, status_code=201)
    def checkout(checkout: Checkout, user: SalesUser):
        if user.role == "admin":
            customer_id = checkout.customer_id
            if customer_id is None or customer_id == user.id:
                raise HTTPException(422, "Select an active customer before placing the order.")
        else:
            if "customer_id" in checkout.model_fields_set:
                raise HTTPException(403, "Customers can only place orders for themselves.")
            customer_id = user.id

        fingerprint = json.dumps(
            {
                "user_id": customer_id,
                **({"placed_by": user.id} if user.role == "admin" else {}),
                "payment_method": checkout.payment_method,
                "items": sorted(
                    [item.model_dump() for item in checkout.items],
                    key=lambda item: item["product_id"],
                ),
            },
            sort_keys=True,
        )
        with connect(app.state.database) as cursor:
            lock_progress(cursor)
            key = str(checkout.idempotency_key)
            cursor.execute(
                "SELECT id, fingerprint, user_id FROM orders WHERE idempotency_key = %s", (key,),
            )
            existing = cursor.fetchone()
            if existing is not None:
                if existing["user_id"] != customer_id or existing["fingerprint"] != fingerprint:
                    raise HTTPException(409, "This checkout key was already used for a different order.")
                return read_order(cursor, existing["id"], user)

            if user.role == "admin":
                cursor.execute(
                    "SELECT id FROM users WHERE id = %s AND role = 'customer' AND active = TRUE FOR UPDATE",
                    (customer_id,),
                )
                if cursor.fetchone() is None:
                    raise HTTPException(422, "The selected customer is no longer available. Reload customers and choose again.")

            cursor.execute(
                """INSERT INTO orders
                   (idempotency_key, fingerprint, user_id, payment_method, total_cents)
                   VALUES (%s, %s, %s, %s, 0)""",
                (key, fingerprint, customer_id, checkout.payment_method),
            )
            order_id = cursor.lastrowid
            total = replace_items(cursor, order_id, checkout.items, [])
            cursor.execute("UPDATE orders SET total_cents = %s WHERE id = %s", (total, order_id))
            record_progress(cursor, order_id, "placed", 1, user.id)
            return read_order(cursor, order_id, user)

    @app.get("/api/orders", response_model=list[Order])
    def orders(
        user: CurrentUser,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        with connect(app.state.database) as cursor:
            if user.role in {"admin", "kitchen"}:
                cursor.execute("SELECT id FROM orders ORDER BY id DESC LIMIT %s OFFSET %s", (limit, offset))
            else:
                cursor.execute(
                    "SELECT id FROM orders WHERE user_id = %s ORDER BY id DESC LIMIT %s OFFSET %s",
                    (user.id, limit, offset),
                )
            ids = cursor.fetchall()
            return [read_order(cursor, row["id"], user) for row in ids]

    @app.get("/api/orders/{order_id}", response_model=Order)
    def order(order_id: int, user: CurrentUser):
        with connect(app.state.database) as cursor:
            return read_order(cursor, order_id, user)

    def lock_order(cursor, order_id: int, expected_version: int):
        lock_progress(cursor)
        cursor.execute("SELECT id, status, kitchen_status, version FROM orders WHERE id = %s FOR UPDATE", (order_id,))
        order = cursor.fetchone()
        if order is None:
            raise HTTPException(404, "Order not found.")
        if order["version"] != expected_version:
            raise HTTPException(409, "This order changed. Refresh it before trying again.")
        if order["status"] == "cancelled":
            raise HTTPException(409, "A cancelled order cannot be changed.")
        if order["kitchen_status"] == "collected":
            raise HTTPException(409, "A collected order cannot be changed or cancelled.")
        return order

    @app.put("/api/orders/{order_id}", response_model=Order)
    def update_order(order_id: int, fields: OrderUpdate, admin: AdminUser):
        with connect(app.state.database) as cursor:
            locked = lock_order(cursor, order_id, fields.expected_version)
            if locked["kitchen_status"] != "placed":
                raise HTTPException(409, "The kitchen has accepted this order. Its items and payment can no longer be edited.")
            existing = read_order(cursor, order_id, admin)
            total = replace_items(cursor, order_id, fields.items, existing["items"])
            cursor.execute(
                """UPDATE orders SET total_cents = %s, payment_method = %s,
                   version = version + 1 WHERE id = %s""",
                (total, fields.payment_method, order_id),
            )
            record_progress(cursor, order_id, "placed", fields.expected_version + 1, admin.id)
            return read_order(cursor, order_id, admin)

    @app.post("/api/orders/{order_id}/cancel", response_model=Order)
    def cancel_order(order_id: int, fields: OrderCancel, admin: AdminUser):
        with connect(app.state.database) as cursor:
            lock_order(cursor, order_id, fields.expected_version)
            existing = read_order(cursor, order_id, admin)
            replace_items(cursor, order_id, [], existing["items"])
            # Keep the original receipt lines and total as cancellation history.
            cursor.executemany(
                """INSERT INTO order_items
                   (order_id, product_id, name, quantity, unit_price_cents)
                   VALUES (%s, %s, %s, %s, %s)""",
                [(order_id, item["product_id"], item["name"], item["quantity"], item["unit_price_cents"])
                 for item in existing["items"]],
            )
            cursor.execute(
                "UPDATE orders SET status = 'cancelled', kitchen_status = 'cancelled', version = version + 1 WHERE id = %s",
                (order_id,),
            )
            record_progress(cursor, order_id, "cancelled", fields.expected_version + 1, admin.id)
            return read_order(cursor, order_id, admin)

    return app


app = create_app()

