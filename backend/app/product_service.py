from fastapi import HTTPException
from pymysql import IntegrityError
from pymysql.constants import ER

from app.database import DatabaseConfig, connect
from app.schemas import Product, ProductCreate, ProductFields, StockUpdate
from app.security import AdminUser, CurrentUser, admin_user
from app.service import create_service


def create_app(config: DatabaseConfig | None = None):
    app = create_service("Counter Products & Inventory", "/api/products", config)

    def read_product(cursor, product_id: int):
        cursor.execute(
            """SELECT id, sku, name, category, price_cents, stock, active
               FROM products WHERE id = %s""",
            (product_id,),
        )
        product = cursor.fetchone()
        if product is None or not product["active"]:
            raise HTTPException(404, "Product not found.")
        return product

    @app.get("/api/products", response_model=list[Product])
    def products(user: CurrentUser, include_archived: bool = False):
        if include_archived:
            admin_user(user)
        with connect(app.state.database) as cursor:
            query = "SELECT id, sku, name, category, price_cents, stock, active FROM products"
            if not include_archived:
                query += " WHERE active = TRUE"
            cursor.execute(query + " ORDER BY name")
            return list(cursor.fetchall())

    def write_product(fields: ProductCreate | ProductFields, product_id: int | None = None):
        with connect(app.state.database) as cursor:
            try:
                if product_id is None:
                    cursor.execute(
                        """INSERT INTO products (sku, name, category, price_cents, stock)
                           VALUES (%(sku)s, %(name)s, %(category)s, %(price_cents)s, %(stock)s)""",
                        fields.model_dump(),
                    )
                    product_id = cursor.lastrowid
                else:
                    cursor.execute("SELECT id, active FROM products WHERE id = %s FOR UPDATE", (product_id,))
                    existing = cursor.fetchone()
                    if existing is None or not existing["active"]:
                        raise HTTPException(404, "Product not found.")
                    cursor.execute(
                        """UPDATE products SET sku = %(sku)s, name = %(name)s,
                           category = %(category)s, price_cents = %(price_cents)s
                           WHERE id = %(id)s""",
                        {**fields.model_dump(), "id": product_id},
                    )
            except IntegrityError as error:
                if error.args[0] == ER.DUP_ENTRY:
                    raise HTTPException(409, "This SKU is already in use, including archived products.") from error
                raise
            return read_product(cursor, product_id)

    @app.post("/api/products", response_model=Product, status_code=201)
    def create_product(fields: ProductCreate, admin: AdminUser):
        return write_product(fields)

    @app.put("/api/products/{product_id}", response_model=Product)
    def update_product(product_id: int, fields: ProductFields, admin: AdminUser):
        return write_product(fields, product_id)

    @app.patch("/api/products/{product_id}/stock", response_model=Product)
    def update_stock(product_id: int, fields: StockUpdate, admin: AdminUser):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id, active FROM products WHERE id = %s FOR UPDATE", (product_id,))
            existing = cursor.fetchone()
            if existing is None or not existing["active"]:
                raise HTTPException(404, "Product not found.")
            cursor.execute("UPDATE products SET stock = %s WHERE id = %s", (fields.stock, product_id))
            return read_product(cursor, product_id)

    @app.delete("/api/products/{product_id}", status_code=204)
    def archive_product(product_id: int, admin: AdminUser):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id FROM products WHERE id = %s FOR UPDATE", (product_id,))
            if cursor.fetchone() is None:
                raise HTTPException(404, "Product not found.")
            cursor.execute("UPDATE products SET active = FALSE WHERE id = %s", (product_id,))

    @app.post("/api/products/{product_id}/restore", response_model=Product)
    def restore_product(product_id: int, admin: AdminUser):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id FROM products WHERE id = %s FOR UPDATE", (product_id,))
            if cursor.fetchone() is None:
                raise HTTPException(404, "Product not found.")
            cursor.execute("UPDATE products SET active = TRUE WHERE id = %s", (product_id,))
            return read_product(cursor, product_id)

    @app.delete("/api/products/{product_id}/permanent", status_code=204)
    def delete_product(product_id: int, admin: AdminUser):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT id, ever_ordered FROM products WHERE id = %s FOR UPDATE", (product_id,))
            product = cursor.fetchone()
            if product is None:
                raise HTTPException(404, "Product not found.")
            if product["ever_ordered"]:
                raise HTTPException(409, "This product has been ordered and cannot be deleted. Archive it instead.")
            try:
                cursor.execute("DELETE FROM products WHERE id = %s", (product_id,))
            except IntegrityError as error:
                if error.args[0] == ER.ROW_IS_REFERENCED_2:
                    raise HTTPException(409, "This product is used in receipts. Archive it instead.") from error
                raise

    return app


app = create_app()

