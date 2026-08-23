FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY qr_login.py code_login.py snapshot_server.py .
CMD ["python", "qr_login.py"]
