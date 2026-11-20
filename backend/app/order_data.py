from fastapi import HTTPException
from pymysql.cursors import DictCursor

from app.schemas import KitchenStatus, User


def progress_row(row: dict) -> dict:
    return {**row, "created_at": row["created_at"].isoformat(timespec="milliseconds") + "Z"}


def lock_progress(cursor: DictCursor) -> None:
    # Serialize event-producing transactions so feed IDs follow commit order.
    cursor.execute("SELECT name FROM app_locks WHERE name = 'order-progress' FOR UPDATE")
    if cursor.fetchone() is None:
        raise RuntimeError("Order progress migration has not been applied.")


def record_progress(
    cursor: DictCursor, order_id: int, status: KitchenStatus, version: int, user_id: int,
) -> None:
    cursor.execute(
        "INSERT INTO order_progress (order_id, status, version, changed_by) VALUES (%s, %s, %s, %s)",
        (order_id, status, version, user_id),
    )


def read_order(cursor: DictCursor, order_id: int, user: User) -> dict:
    cursor.execute(
        """SELECT o.id, o.created_at, o.payment_method, o.total_cents,
                  o.user_id, o.status, o.kitchen_status, o.version,
                  u.name AS customer_name, u.email AS customer_email
           FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = %s""",
        (order_id,),
    )
    row = cursor.fetchone()
    if row is None or (user.role == "customer" and row["user_id"] != user.id):
        raise HTTPException(404, "Order not found.")
    cursor.execute(
        """SELECT product_id, name, quantity, unit_price_cents
           FROM order_items WHERE order_id = %s ORDER BY id""",
        (order_id,),
    )
    items = list(cursor.fetchall())
    cursor.execute(
        """SELECT id, order_id, status, version, created_at
           FROM order_progress WHERE order_id = %s ORDER BY id""",
        (order_id,),
    )
    return {
        **row,
        "created_at": row["created_at"].isoformat(timespec="milliseconds") + "Z",
        "items": items,
        "progress": [progress_row(event) for event in cursor.fetchall()],
    }

