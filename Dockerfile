FROM python:3.12-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    SHIFTLITE_DB=/data/shiftlite.db

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt waitress

COPY . .

# /data：SQLite 数据库持久化卷；/app/static/uploads：品牌头像持久化卷
VOLUME ["/data", "/app/static/uploads"]
EXPOSE 5001

CMD ["waitress-serve", "--host=0.0.0.0", "--port=5001", "--threads=4", "app:app"]
