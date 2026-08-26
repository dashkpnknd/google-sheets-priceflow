FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY price_engine.py snapshot_server.py .
CMD ["python", "snapshot_server.py"]
