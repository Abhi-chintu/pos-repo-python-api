import json
from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator

from fastapi import FastAPI, HTTPException, Query, Request, status
from pymysql import IntegrityError
from pymysql.constants import ER
from pymysql.cursors import DictCursor

from app.database import DatabaseConfig, connect, initialize
from app.schemas import Checkout, Order, Product, ProductCreate, StockUpdate


def read_order(cursor: DictCursor, order_id: int) -> dict:
    cursor.execute(
        "SELECT id, created_at, payment_method, total_cents FROM orders WHERE id = %s",
        (order_id,),
    )
    row = cursor.fetchone()
    if row is None:
        raise HTTPException(404, "Receipt not found.")
    cursor.execute(
        """SELECT product_id, name, quantity, unit_price_cents
           FROM order_items WHERE order_id = %s ORDER BY id""",
        (order_id,),
    )
    return {
        **row,
        "created_at": row["created_at"].isoformat(timespec="milliseconds") + "Z",
        "items": list(cursor.fetchall()),
    }


def create_app(database_config: DatabaseConfig | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.database = database_config or DatabaseConfig.from_env()
        initialize(app.state.database)
        yield

    app = FastAPI(title="Counter POS API", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def api_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/api/health")
    def health() -> dict[str, str]:
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
        return {"status": "ok"}

    @app.get("/api/products", response_model=list[Product])
    def products() -> list[dict]:
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT * FROM products ORDER BY name")
            return list(cursor.fetchall())

    @app.post("/api/products", response_model=Product, status_code=status.HTTP_201_CREATED)
    def create_product(product: ProductCreate) -> dict:
        with connect(app.state.database) as cursor:
            try:
                cursor.execute(
                    """INSERT INTO products (sku, name, category, price_cents, stock)
                       VALUES (%(sku)s, %(name)s, %(category)s, %(price_cents)s, %(stock)s)""",
                    product.model_dump(),
                )
            except IntegrityError as error:
                if error.args[0] == ER.DUP_ENTRY:
                    raise HTTPException(409, "A product with this SKU already exists.") from error
                raise
            cursor.execute("SELECT * FROM products WHERE id = %s", (cursor.lastrowid,))
            return cursor.fetchone()

    @app.patch("/api/products/{product_id}/stock", response_model=Product)
    def update_stock(product_id: int, update: StockUpdate) -> dict:
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id FROM products WHERE id = %s FOR UPDATE", (product_id,))
            if cursor.fetchone() is None:
                raise HTTPException(404, "Product not found.")
            cursor.execute(
                "UPDATE products SET stock = %s WHERE id = %s", (update.stock, product_id)
            )
            cursor.execute("SELECT * FROM products WHERE id = %s", (product_id,))
            return cursor.fetchone()

    @app.post("/api/orders", response_model=Order, status_code=status.HTTP_201_CREATED)
    def checkout(checkout: Checkout) -> dict:
        fingerprint = json.dumps(
            {
                "payment_method": checkout.payment_method,
                "items": sorted(
                    [item.model_dump() for item in checkout.items],
                    key=lambda item: item["product_id"],
                ),
            },
            sort_keys=True,
        )
        with connect(app.state.database) as cursor:
            # Reserve the unique retry key before locking stock. The total is
            # finalized in the same transaction, or the whole sale is rolled back.
            try:
                cursor.execute(
                    """INSERT INTO orders
                       (idempotency_key, fingerprint, payment_method, total_cents)
                       VALUES (%s, %s, %s, 0)""",
                    (str(checkout.idempotency_key), fingerprint, checkout.payment_method),
                )
            except IntegrityError as error:
                if error.args[0] != ER.DUP_ENTRY:
                    raise
                cursor.execute(
                    "SELECT id, fingerprint FROM orders WHERE idempotency_key = %s",
                    (str(checkout.idempotency_key),),
                )
                existing = cursor.fetchone()
                if existing is None:
                    raise
                if existing["fingerprint"] != fingerprint:
                    raise HTTPException(409, "This checkout key was used for a different cart.") from error
                return read_order(cursor, existing["id"])
            order_id = cursor.lastrowid

            total_cents = 0
            # A consistent lock order prevents deadlocks for overlapping carts.
            for item in sorted(checkout.items, key=lambda item: item.product_id):
                cursor.execute(
                    "SELECT * FROM products WHERE id = %s FOR UPDATE", (item.product_id,)
                )
                product = cursor.fetchone()
                if product is None:
                    raise HTTPException(404, f"Product {item.product_id} not found.")
                if product["stock"] < item.quantity:
                    raise HTTPException(409, f"Not enough stock for {product['name']}.")
                total_cents += product["price_cents"] * item.quantity
                cursor.execute(
                    "UPDATE products SET stock = stock - %s WHERE id = %s",
                    (item.quantity, product["id"]),
                )
                cursor.execute(
                    """INSERT INTO order_items
                       (order_id, product_id, name, quantity, unit_price_cents)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (order_id, product["id"], product["name"], item.quantity, product["price_cents"]),
                )
            cursor.execute(
                "UPDATE orders SET total_cents = %s WHERE id = %s", (total_cents, order_id)
            )
            return read_order(cursor, order_id)

    @app.get("/api/orders", response_model=list[Order])
    def orders(limit: Annotated[int, Query(ge=1, le=100)] = 50) -> list[dict]:
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id FROM orders ORDER BY id DESC LIMIT %s", (limit,))
            ids = cursor.fetchall()
            return [read_order(cursor, row["id"]) for row in ids]

    @app.get("/api/orders/{order_id}", response_model=Order)
    def order(order_id: int) -> dict:
        with connect(app.state.database) as cursor:
            return read_order(cursor, order_id)

    return app


app = create_app()
