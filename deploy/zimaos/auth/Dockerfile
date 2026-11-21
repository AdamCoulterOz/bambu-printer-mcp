FROM python:3.12-alpine@sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b
WORKDIR /app
COPY requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.lock
COPY bridge.py runtime.py dual_runtime.py launch.sh /app/
USER 1000:1000
ENTRYPOINT ["/app/launch.sh"]
CMD ["uvicorn", "dual_runtime:app", "--factory", "--host", "127.0.0.1", "--port", "8188", "--no-access-log"]
