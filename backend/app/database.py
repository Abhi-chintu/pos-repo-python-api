import os
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

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
def connect(config: DatabaseConfig) -> Iterator[DictCursor]:
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
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            sku VARCHAR(40) NOT NULL UNIQUE,
            name VARCHAR(100) NOT NULL,
            category VARCHAR(100) NOT NULL,
            price_cents INTEGER NOT NULL CHECK (price_cents > 0),
            stock INTEGER NOT NULL CHECK (stock >= 0)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
            idempotency_key CHAR(36) NOT NULL UNIQUE,
            fingerprint TEXT NOT NULL,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            payment_method VARCHAR(4) NOT NULL CHECK (payment_method IN ('cash', 'card')),
            total_cents BIGINT NOT NULL CHECK (total_cents >= 0)
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
        for statement in statements:
            cursor.execute(statement)
