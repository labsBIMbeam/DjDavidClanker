"""Test env must exist before `app` is imported anywhere."""

import os

os.environ.setdefault("INGEST_DATA", "./test-data")
