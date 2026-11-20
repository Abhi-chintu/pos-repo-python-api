from typing import Annotated, Literal

from fastapi import HTTPException, Query

from app.database import DatabaseConfig, connect
from app.order_data import lock_progress, progress_row, read_order, record_progress
from app.schemas import KitchenUpdate, Order, ProgressUpdates
from app.security import CurrentUser, KitchenUser
from app.service import create_service

NEXT_STATUS = {
    "placed": "accepted",
    "accepted": "preparing",
    "preparing": "ready",
    "ready": "collected",
}


def create_app(config: DatabaseConfig | None = None):
    app = create_service("Counter Kitchen", "/api/kitchen", config)

    @app.get("/api/kitchen/orders", response_model=list[Order])
    def orders(
        staff: KitchenUser,
        view: Literal["active", "history"] = "active",
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        with connect(app.state.database) as cursor:
            if view == "active":
                cursor.execute(
                    """SELECT id FROM orders WHERE status = 'placed'
                       AND kitchen_status <> 'collected' ORDER BY id LIMIT %s OFFSET %s""",
                    (limit, offset),
                )
            else:
                cursor.execute(
                    """SELECT id FROM orders WHERE status = 'cancelled'
                       OR kitchen_status = 'collected' ORDER BY id DESC LIMIT %s OFFSET %s""",
                    (limit, offset),
                )
            ids = cursor.fetchall()
            return [read_order(cursor, row["id"], staff) for row in ids]

    @app.patch("/api/kitchen/orders/{order_id}/status", response_model=Order)
    def update_status(order_id: int, fields: KitchenUpdate, staff: KitchenUser):
        with connect(app.state.database) as cursor:
            lock_progress(cursor)
            cursor.execute(
                "SELECT status, kitchen_status, version FROM orders WHERE id = %s FOR UPDATE", (order_id,),
            )
            existing = cursor.fetchone()
            if existing is None:
                raise HTTPException(404, "Order not found.")
            if existing["version"] != fields.expected_version:
                raise HTTPException(409, "This order changed. Refresh it before trying again.")
            if existing["status"] == "cancelled" or NEXT_STATUS.get(existing["kitchen_status"]) != fields.status:
                raise HTTPException(409, "This kitchen status transition is not allowed. Refresh the order.")
            cursor.execute(
                "UPDATE orders SET kitchen_status = %s, version = version + 1 WHERE id = %s",
                (fields.status, order_id),
            )
            record_progress(cursor, order_id, fields.status, fields.expected_version + 1, staff.id)
            return read_order(cursor, order_id, staff)

    @app.get("/api/kitchen/updates", response_model=ProgressUpdates)
    def updates(user: CurrentUser, after_id: Annotated[int | None, Query(ge=0)] = None):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT COALESCE(MAX(id), 0) AS latest FROM order_progress")
            latest = cursor.fetchone()["latest"]
            if after_id is None:
                return {"events": [], "cursor": latest, "has_more": False}
            if after_id > latest:
                raise HTTPException(409, "The progress feed changed. Reload the page to restart tracking.")
            query = """SELECT p.id, p.order_id, p.status, p.version, p.created_at
                       FROM order_progress p JOIN orders o ON o.id = p.order_id
                       WHERE p.id > %s AND p.id <= %s"""
            parameters = [after_id, latest]
            if user.role == "customer":
                query += " AND o.user_id = %s"
                parameters.append(user.id)
            cursor.execute(query + " ORDER BY p.id LIMIT 101", tuple(parameters))
            events = list(cursor.fetchall())
            has_more = len(events) > 100
            events = events[:100]
            return {
                "events": [progress_row(event) for event in events],
                "cursor": events[-1]["id"] if has_more else latest,
                "has_more": has_more,
            }

    return app


app = create_app()

