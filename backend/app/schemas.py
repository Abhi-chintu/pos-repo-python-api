from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel, ConfigDict, EmailStr, Field, StringConstraints, field_validator,
    model_validator,
)

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Stock = Annotated[int, Field(strict=True, ge=0, le=1_000_000)]


class ProductFields(BaseModel):
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


class ProductCreate(ProductFields):
    stock: Stock


class Product(ProductCreate):
    id: int
    active: bool


class StockUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stock: Stock


class CartItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: Annotated[int, Field(strict=True, gt=0)]
    quantity: Annotated[int, Field(strict=True, gt=0, le=10_000)]


class OrderContents(BaseModel):
    model_config = ConfigDict(extra="forbid")

    payment_method: Literal["cash", "card"]
    items: Annotated[list[CartItem], Field(min_length=1, max_length=100)]

    @model_validator(mode="after")
    def unique_products(self) -> "OrderContents":
        ids = [item.product_id for item in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("Each product must appear only once.")
        return self


class Checkout(OrderContents):
    idempotency_key: UUID


class OrderUpdate(OrderContents):
    expected_version: Annotated[int, Field(strict=True, gt=0)]


class OrderCancel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Annotated[int, Field(strict=True, gt=0)]


class OrderItem(BaseModel):
    product_id: int
    name: str
    quantity: int
    unit_price_cents: int


KitchenStatus = Literal["placed", "accepted", "preparing", "ready", "collected", "cancelled"]


class OrderProgress(BaseModel):
    id: int
    order_id: int
    status: KitchenStatus
    version: int
    created_at: str


class KitchenUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["accepted", "preparing", "ready", "collected"]
    expected_version: Annotated[int, Field(strict=True, gt=0)]


class ProgressUpdates(BaseModel):
    events: list[OrderProgress]
    cursor: int
    has_more: bool


class Order(BaseModel):
    id: int
    created_at: str
    payment_method: Literal["cash", "card"]
    total_cents: int
    items: list[OrderItem]
    user_id: int | None
    customer_name: str | None
    customer_email: str | None
    status: Literal["placed", "cancelled"]
    kitchen_status: KitchenStatus
    version: int
    progress: list[OrderProgress]


Password = Annotated[str, StringConstraints(min_length=10, max_length=128)]
Role = Literal["admin", "customer", "kitchen"]


class UserFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name
    email: Annotated[EmailStr, Field(max_length=254)]

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class Registration(UserFields):
    password: Password


class UserCreate(Registration):
    role: Role = "customer"


class UserUpdate(UserFields):
    role: Role
    active: bool
    password: Password | None = None


class Login(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Annotated[EmailStr, Field(max_length=254)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=128)]

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class User(UserFields):
    id: int
    role: Role
    active: bool

