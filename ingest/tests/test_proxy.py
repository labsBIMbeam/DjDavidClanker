"""The /proxy CORS relay: guards first, then one real fetch.

The guard tests are pure and fast. The live test follows the house policy
(suites hit the REAL APIs): it pulls one small JSON from the Wavlake catalog
through the relay and checks the CORS header the whole endpoint exists for.
"""

from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_proxy_refuses_non_http_schemes():
    r = client.get("/proxy", params={"url": "ftp://example.com/x"})
    assert r.status_code == 400


def test_proxy_refuses_loopback_targets():
    r = client.get("/proxy", params={"url": "http://127.0.0.1:9/secret"})
    assert r.status_code == 400
    assert "private" in r.json()["detail"]


def test_proxy_refuses_private_ranges():
    r = client.get("/proxy", params={"url": "http://10.0.0.1/x"})
    assert r.status_code == 400


def test_proxy_relays_wavlake_catalog_with_cors():
    r = client.get(
        "/proxy",
        params={"url": "https://catalog.wavlake.com/v1/charts/music/top?limit=1"},
        headers={"Origin": "null"},
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") == "*"
    assert b"data" in r.content or b"title" in r.content
