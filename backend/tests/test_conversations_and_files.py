from __future__ import annotations

import io


def _new_conversation(client, headers, title="Inspection review"):
    response = client.post(
        "/api/v1/conversations", json={"title": title}, headers=headers
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_conversation_round_trip(client, auth_headers):
    conversation = _new_conversation(client, auth_headers)

    posted = client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={"content": "Summarise the latest vessel inspection."},
        headers=auth_headers,
    )
    assert posted.status_code == 201

    detail = client.get(
        f"/api/v1/conversations/{conversation['id']}", headers=auth_headers
    )
    assert detail.status_code == 200
    assert len(detail.json()["messages"]) == 1

    listing = client.get("/api/v1/conversations", headers=auth_headers)
    assert listing.status_code == 200
    assert listing.json()["total"] >= 1


def test_another_users_conversation_is_not_visible(client, auth_headers, make_user):
    conversation = _new_conversation(client, auth_headers)

    other, password = make_user()
    token = client.post(
        "/api/v1/auth/login", json={"email": other.email, "password": password}
    ).json()["access_token"]

    response = client.get(
        f"/api/v1/conversations/{conversation['id']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 404


def test_upload_accepts_a_supported_document(client, auth_headers):
    response = client.post(
        "/api/v1/files/upload",
        files={"file": ("sop.txt", io.BytesIO(b"Vessel entry SOP v3"), "text/plain")},
        headers=auth_headers,
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["size_bytes"] == 19
    assert len(body["sha256"]) == 64

    fetched = client.get(f"/api/v1/files/{body['id']}", headers=auth_headers)
    assert fetched.status_code == 200


def test_upload_rejects_an_unsupported_type(client, auth_headers):
    response = client.post(
        "/api/v1/files/upload",
        files={"file": ("payload.exe", io.BytesIO(b"MZ"), "application/x-msdownload")},
        headers=auth_headers,
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"


def test_upload_rejects_an_oversized_file(client, auth_headers, monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.settings, "max_upload_size_mb", 0.0001)
    response = client.post(
        "/api/v1/files/upload",
        files={"file": ("big.txt", io.BytesIO(b"x" * 5000), "text/plain")},
        headers=auth_headers,
    )
    assert response.status_code == 413


def test_deleted_file_is_gone(client, auth_headers):
    uploaded = client.post(
        "/api/v1/files/upload",
        files={"file": ("notes.txt", io.BytesIO(b"scratch"), "text/plain")},
        headers=auth_headers,
    ).json()

    assert (
        client.delete(f"/api/v1/files/{uploaded['id']}", headers=auth_headers).status_code
        == 204
    )
    assert (
        client.get(f"/api/v1/files/{uploaded['id']}", headers=auth_headers).status_code
        == 404
    )
