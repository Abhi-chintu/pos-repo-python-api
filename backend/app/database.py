import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Generator

import pymysql
from pymysql.cursors import DictCursor


@dataclass(frozen=True)
class DatabaseConfig:
    host: str
    port: int
    user: str
    password: str
    database: str

    @classmethod
    def from_env(cls, prefix: str = "MYSQL") -> "DatabaseConfig":
        return cls(
            host=os.environ.get(f"{prefix}_HOST", "127.0.0.1"),
            port=int(os.environ.get(f"{prefix}_PORT", "3306")),
            user=os.environ[f"{prefix}_USER"],
            password=os.environ[f"{prefix}_PASSWORD"],
            database=os.environ[f"{prefix}_DATABASE"],
        )


@contextmanager
def connect(config: DatabaseConfig) -> Generator[DictCursor, None, None]:
    connection = pymysql.connect(
        host=config.host,
        port=config.port,
        user=config.user,
        password=config.password,
        database=config.database,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
        connect_timeout=10,
        init_command="SET time_zone = '+00:00'",
    )
    try:
        with connection.cursor() as cursor:
            yield cursor
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize(config: DatabaseConfig) -> None:
    statements = [
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(254) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(8) NOT NULL CONSTRAINT users_role CHECK (role IN ('admin', 'customer', 'kitchen')),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS user_sessions (
            token_hash CHAR(64) NOT NULL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at DATETIME(6) NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id),
            INDEX (expires_at)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS app_locks (
            name VARCHAR(40) NOT NULL PRIMARY KEY
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            sku VARCHAR(40) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            category VARCHAR(100) NOT NULL,
            price_cents INTEGER NOT NULL CHECK (price_cents > 0),
            stock INTEGER NOT NULL CHECK (stock >= 0),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            ever_ordered BOOLEAN NOT NULL DEFAULT FALSE
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            idempotency_key CHAR(36) NOT NULL UNIQUE,
            fingerprint TEXT NOT NULL,
            user_id INTEGER NULL,
            status VARCHAR(10) NOT NULL DEFAULT 'placed',
            kitchen_status VARCHAR(10) NOT NULL DEFAULT 'placed',
            version INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            payment_method VARCHAR(4) NOT NULL CHECK (payment_method IN ('cash', 'card')),
            total_cents BIGINT NOT NULL CHECK (total_cents >= 0)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS order_progress (
            id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            order_id INTEGER NOT NULL,
            status VARCHAR(10) NOT NULL,
            version INTEGER NOT NULL,
            changed_by INTEGER NOT NULL,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (changed_by) REFERENCES users(id),
            UNIQUE (order_id, version)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            order_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            name VARCHAR(100) NOT NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
            FOREIGN KEY (order_id) REFERENCES orders(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        ) ENGINE=InnoDB
        """,
    ]
    with connect(config) as cursor:
        cursor.execute("SELECT GET_LOCK('counter-schema-v2', 30) AS acquired")
        if cursor.fetchone()["acquired"] != 1:
            raise RuntimeError("Could not acquire the database migration lock.")
        try:
            for statement in statements:
                cursor.execute(statement)
            # Existing installations keep their stock and receipt data.
            additions = {
                "products": {
                    "active": "BOOLEAN NOT NULL DEFAULT TRUE",
                    "ever_ordered": "BOOLEAN NOT NULL DEFAULT FALSE",
                },
                "orders": {
                    "user_id": "INTEGER NULL",
                    "status": "VARCHAR(10) NOT NULL DEFAULT 'placed'",
                    "version": "INTEGER NOT NULL DEFAULT 1",
                    # Pre-kitchen sales must not reappear as new kitchen tickets.
                    "kitchen_status": "VARCHAR(10) NOT NULL DEFAULT 'collected'",
                },
            }
            for table, columns in additions.items():
                cursor.execute(f"SHOW COLUMNS FROM {table}")
                existing = {row["Field"] for row in cursor.fetchall()}
                for column, definition in columns.items():
                    if column not in existing:
                        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            cursor.execute("SHOW COLUMNS FROM orders LIKE 'kitchen_status'")
            if cursor.fetchone()["Default"] != "placed":
                cursor.execute("ALTER TABLE orders ALTER COLUMN kitchen_status SET DEFAULT 'placed'")
            cursor.execute(
                "UPDATE orders SET kitchen_status = 'cancelled' WHERE status = 'cancelled' AND kitchen_status <> 'cancelled'"
            )
            cursor.execute(
                """SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
                   FROM information_schema.TABLE_CONSTRAINTS tc
                   JOIN information_schema.CHECK_CONSTRAINTS cc
                     ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
                     AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                   WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = 'users'
                     AND tc.CONSTRAINT_TYPE = 'CHECK'"""
            )
            role_checks = [row for row in cursor.fetchall() if "`role`" in row["CHECK_CLAUSE"]]
            if not role_checks or any("kitchen" not in row["CHECK_CLAUSE"] for row in role_checks):
                changes = [
                    "DROP CHECK `" + row["CONSTRAINT_NAME"].replace("`", "``") + "`"
                    for row in role_checks
                ]
                changes.append("ADD CONSTRAINT users_role CHECK (role IN ('admin', 'customer', 'kitchen'))")
                cursor.execute("ALTER TABLE users " + ", ".join(changes))
            cursor.execute(
                """UPDATE products p SET ever_ordered = TRUE
                   WHERE ever_ordered = FALSE AND EXISTS
                   (SELECT 1 FROM order_items i WHERE i.product_id = p.id)"""
            )
            cursor.execute("INSERT IGNORE INTO app_locks (name) VALUES ('user-admin')")
            cursor.execute("INSERT IGNORE INTO app_locks (name) VALUES ('order-progress')")
        finally:
            cursor.execute("SELECT RELEASE_LOCK('counter-schema-v2')")
