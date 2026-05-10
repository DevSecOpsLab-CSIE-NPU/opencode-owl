"""Shared JSON-RPC client for the owl MCP server."""
from __future__ import annotations
import json
import os
import urllib.request
import urllib.error

OWL_MCP_URL = os.environ.get("OWL_MCP_URL", "http://localhost:3100/rpc")


def owl_rpc(method: str, params: dict, url: str = OWL_MCP_URL) -> dict | None:
    """Send a JSON-RPC call to the owl MCP server. Returns None if server is unreachable."""
    payload = json.dumps(
        {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    ).encode()
    try:
        req = urllib.request.Request(
            url, data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except (urllib.error.URLError, OSError):
        return None


def query_memory(query: str, limit: int = 3) -> list[dict]:
    """Query owl memory and return a list of matching entries (empty on failure)."""
    resp = owl_rpc("memory_query", {"query": query, "limit": limit})
    if not resp:
        return []
    result = resp.get("result", [])
    return result if isinstance(result, list) else []
