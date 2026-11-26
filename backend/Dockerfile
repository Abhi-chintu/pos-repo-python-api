FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --system pos \
    && useradd --system --gid pos pos
COPY --chown=pos:pos app ./app

USER pos

EXPOSE 8000

FROM base AS auth
CMD ["uvicorn", "app.auth_service:app", "--host", "0.0.0.0"]

FROM base AS products
CMD ["uvicorn", "app.product_service:app", "--host", "0.0.0.0"]

FROM base AS kitchen
CMD ["uvicorn", "app.kitchen_service:app", "--host", "0.0.0.0"]

FROM base AS orders
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0"]

