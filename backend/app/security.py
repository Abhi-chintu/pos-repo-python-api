import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import Depends, HTTPException, Request, Response

from app.database import connect
from app.schemas import User

SESSION_COOKIE = "counter_session"
SESSION_SECONDS = 8 * 60 * 60


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode(), salt=salt, n=32768, r=8, p=3, dklen=64, maxmem=64 * 1024 * 1024,
    )
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str) -> bool:
    scheme, salt, digest = stored.split("$")
    if scheme != "scrypt":
        raise RuntimeError("Unsupported stored password format.")
    actual = hashlib.scrypt(
        password.encode(), salt=base64.b64decode(salt), n=32768, r=8, p=3,
        dklen=64, maxmem=64 * 1024 * 1024,
    )
    return hmac.compare_digest(actual, base64.b64decode(digest))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def set_session(cursor, user_id: int, request: Request, response: Response) -> None:
    old_token = request.cookies.get(SESSION_COOKIE)
    if old_token:
        cursor.execute("DELETE FROM user_sessions WHERE token_hash = %s", (token_hash(old_token),))
    token = secrets.token_urlsafe(32)
    expiry = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=SESSION_SECONDS)
    cursor.execute(
        "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
        (token_hash(token), user_id, expiry),
    )
    response.set_cookie(
        SESSION_COOKIE, token, max_age=SESSION_SECONDS, httponly=True, samesite="lax",
        secure=os.environ.get("COOKIE_SECURE", "false").lower() == "true", path="/api",
    )


def current_user(request: Request) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    if not token or len(token) > 128:
        raise HTTPException(401, "Please log in.")
    with connect(request.app.state.database) as cursor:
        cursor.execute(
            """SELECT u.id, u.name, u.email, u.role, u.active
               FROM users u JOIN user_sessions s ON s.user_id = u.id
               WHERE s.token_hash = %s AND s.expires_at > UTC_TIMESTAMP(6)
               AND u.active = TRUE""",
            (token_hash(token),),
        )
        user = cursor.fetchone()
    if user is None:
        raise HTTPException(401, "Your session has expired. Please log in again.")
    return User.model_validate(user)


CurrentUser = Annotated[User, Depends(current_user)]


def admin_user(user: CurrentUser) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Administrator access is required.")
    return user


AdminUser = Annotated[User, Depends(admin_user)]


def kitchen_user(user: CurrentUser) -> User:
    if user.role not in {"admin", "kitchen"}:
        raise HTTPException(403, "Kitchen or administrator access is required.")
    return user


KitchenUser = Annotated[User, Depends(kitchen_user)]


def sales_user(user: CurrentUser) -> User:
    if user.role not in {"admin", "customer"}:
        raise HTTPException(403, "Kitchen accounts can only view orders and update kitchen progress.")
    return user


SalesUser = Annotated[User, Depends(sales_user)]

