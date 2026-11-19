from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Stock = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]


class ProductCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sku: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True,
            to_upper=True,
            min_length=1,
            max_length=40,
            pattern=r"^[A-Za-z0-9_-]+$",
        ),
    ]
    name: Name
    category: Name
    price_cents: Annotated[int, Field(strict=True, gt=0, le=100_000_000)]
    stock: Stock


class Product(ProductCreate):
    id: int


class StockUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stock: Stock


class CartItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: Annotated[int, Field(strict=True, gt=0)]
    quantity: Annotated[int, Field(strict=True, gt=0, le=10_000)]


class Checkout(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: UUID
    payment_method: Literal["cash", "card"]
    items: Annotated[list[CartItem], Field(min_length=1, max_length=100)]

    @model_validator(mode="after")
    def unique_products(self) -> "Checkout":
        ids = [item.product_id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("Each product must appear only once.")
        return self


class OrderItem(BaseModel):
    product_id: int
    name: str
    quantity: int
    unit_price_cents: int


class Order(BaseModel):
    id: int
    created_at: str
    payment_method: Literal["cash", "card"]
    total_cents: int
    items: list[OrderItem]
