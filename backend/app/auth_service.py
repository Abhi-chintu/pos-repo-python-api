import os
from typing import Annotated

from fastapi import HTTPException, Query, Request, Response
from pymysql import IntegrityError
from pymysql.constants import ER

from app.database import DatabaseConfig, connect, initialize
from app.schemas import Login, Registration, User, UserCreate, UserUpdate
from app.security import (
    AdminUser, CurrentUser, SESSION_COOKIE, hash_password, set_session, token_hash,
    verify_password,
)
from app.service import create_service

USER_COLUMNS = "id, name, email, role, active"
# Make unknown-user logins perform the same expensive password operation.
DUMMY_PASSWORD_HASH = hash_password("not-a-real-user-password")


def insert_user(cursor, fields: Registration, role: str) -> dict:
    try:
        cursor.execute(
            "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, %s, %s)",
            (fields.name, str(fields.email), hash_password(fields.password), role),
        )
    except IntegrityError as error:
        if error.args[0] == ER.DUP_ENTRY:
            raise HTTPException(409, "An account with this email already exists.") from error
        raise
    user_id = cursor.lastrowid
    cursor.execute(f"SELECT {USER_COLUMNS} FROM users WHERE id = %s", (user_id,))
    return cursor.fetchone()


def setup(config: DatabaseConfig) -> None:
    initialize(config)
    with connect(config) as cursor:
        cursor.execute("SELECT name FROM app_locks WHERE name = 'user-admin' FOR UPDATE")
        cursor.execute("DELETE FROM user_sessions WHERE expires_at <= UTC_TIMESTAMP(6)")
        cursor.execute("SELECT id FROM users WHERE role = 'admin' AND active = TRUE LIMIT 1")
        if cursor.fetchone() is None:
            fields = Registration(
                name=os.environ.get("ADMIN_NAME", "Administrator"),
                email=os.environ["ADMIN_EMAIL"],
                password=os.environ["ADMIN_PASSWORD"],
            )
            insert_user(cursor, fields, "admin")


def create_app(config: DatabaseConfig | None = None):
    app = create_service("Counter Auth & Users", "/api/auth", config, startup=setup)

    @app.post("/api/auth/register", response_model=User, status_code=201)
    def register(fields: Registration, request: Request, response: Response):
        with connect(app.state.database) as cursor:
            user = insert_user(cursor, fields, "customer")
            set_session(cursor, user["id"], request, response)
            return user

    @app.post("/api/auth/login", response_model=User)
    def login(fields: Login, request: Request, response: Response):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT * FROM users WHERE email = %s", (str(fields.email),))
            user = cursor.fetchone()
            valid = verify_password(fields.password, user["password_hash"] if user else DUMMY_PASSWORD_HASH)
            if user is None or not valid or not user["active"]:
                raise HTTPException(401, "Invalid email or password.")
            set_session(cursor, user["id"], request, response)
            return {key: user[key] for key in ("id", "name", "email", "role", "active")}

    @app.get("/api/auth/me", response_model=User)
    def me(user: CurrentUser):
        return user

    @app.post("/api/auth/logout", status_code=204)
    def logout(request: Request, response: Response):
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            with connect(app.state.database) as cursor:
                cursor.execute("DELETE FROM user_sessions WHERE token_hash = %s", (token_hash(token),))
        response.delete_cookie(SESSION_COOKIE, path="/api", httponly=True, samesite="lax")

    @app.get("/api/users", response_model=list[User])
    def users(
        admin: AdminUser,
        limit: Annotated[int, Query(ge=1, le=100)] = 100,
        offset: Annotated[int, Query(ge=0)] = 0,
    ):
        with connect(app.state.database) as cursor:
            cursor.execute(f"SELECT {USER_COLUMNS} FROM users ORDER BY id LIMIT %s OFFSET %s", (limit, offset))
            return list(cursor.fetchall())

    @app.post("/api/users", response_model=User, status_code=201)
    def create_user(fields: UserCreate, admin: AdminUser):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT name FROM app_locks WHERE name = 'user-admin' FOR UPDATE")
            return insert_user(cursor, fields, fields.role)

    def change_user(user_id: int, fields: UserUpdate | None):
        with connect(app.state.database) as cursor:
            cursor.execute("SELECT name FROM app_locks WHERE name = 'user-admin' FOR UPDATE")
            cursor.execute(f"SELECT {USER_COLUMNS} FROM users WHERE id = %s FOR UPDATE", (user_id,))
            existing = cursor.fetchone()
            if existing is None:
                raise HTTPException(404, "User not found.")
            role = fields.role if fields else existing["role"]
            active = fields.active if fields else False
            if existing["role"] == "admin" and existing["active"] and (role != "admin" or not active):
                cursor.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = TRUE")
                if cursor.fetchone()["count"] <= 1:
                    raise HTTPException(409, "The last active administrator cannot be deactivated or demoted.")
            if fields:
                try:
                    cursor.execute(
                        "UPDATE users SET name = %s, email = %s, role = %s, active = %s WHERE id = %s",
                        (fields.name, str(fields.email), role, active, user_id),
                    )
                except IntegrityError as error:
                    if error.args[0] == ER.DUP_ENTRY:
                        raise HTTPException(409, "An account with this email already exists.") from error
                    raise
                if fields.password is not None:
                    cursor.execute("UPDATE users SET password_hash = %s WHERE id = %s", (hash_password(fields.password), user_id))
            else:
                cursor.execute("UPDATE users SET active = FALSE WHERE id = %s", (user_id,))
            # Role, profile and password edits revoke existing sessions immediately.
            cursor.execute("DELETE FROM user_sessions WHERE user_id = %s", (user_id,))
            cursor.execute(f"SELECT {USER_COLUMNS} FROM users WHERE id = %s", (user_id,))
            return cursor.fetchone()

    @app.put("/api/users/{user_id}", response_model=User)
    def update_user(user_id: int, fields: UserUpdate, admin: AdminUser):
        return change_user(user_id, fields)

    @app.delete("/api/users/{user_id}", response_model=User)
    def deactivate_user(user_id: int, admin: AdminUser):
        return change_user(user_id, None)

    return app


app = create_app()

