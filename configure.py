#!/usr/bin/env python3
"""Collect Omada credentials locally, without arguments, logs, or chat.

Two modes:
  --token      Store a pre-fetched OAuth access token (OMADA_ACCESS_TOKEN equivalent).
  (default)    Store an Open API application's Client ID + Client Secret.

Credentials land in .secrets/credentials.json (dir 700, file 600). Prefer setting
the matching environment variables instead of this file when you can; this exists
for convenience. Never paste secrets into a chat or commit them.
"""
import argparse
import getpass
import json
import os
import stat
from pathlib import Path
import tempfile


def write(path, data):
    folder = path.parent
    folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    fd, temporary = tempfile.mkstemp(dir=folder)
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"Saved to {path} (owner-only). No network requests were made.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--token",
        action="store_true",
        help="Store a pre-fetched OAuth access token instead of Client ID/Secret",
    )
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    path = root / ".secrets" / "credentials.json"

    if args.token:
        print("Paste the OAuth access token from Omada's Platform Integration > Open API.")
        print("Tokens expire; set OMADA_ACCESS_TOKEN in your MCP config to refresh without this file.")
        token = getpass.getpass("Access token (hidden): ").strip()
        if not token:
            raise SystemExit("No token entered; existing file was not changed.")
        write(path, {"accessToken": token})
        return

    print("In Omada: Settings > Platform Integration > Open API, add an application in Client mode.")
    print("Use the narrowest role/permissions your read-only needs allow. Do not reuse your admin password.")
    client_id = getpass.getpass("Open API Client ID (hidden): ").strip()
    client_secret = getpass.getpass("Open API Client Secret (hidden): ").strip()
    if not client_id or not client_secret:
        raise SystemExit("Both values are required; existing file was not changed.")
    write(path, {"clientId": client_id, "clientSecret": client_secret})


if __name__ == "__main__":
    main()
