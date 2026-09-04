from __future__ import annotations


def test_login_returns_token_and_me_resolves_it(client, make_user):
    user, password = make_user(roles=["ENGINEER", "MANAGER"])

    login = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": password}
    )
    assert login.status_code == 200
    token = login.json()["access_token"]

    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    body = me.json()
    assert body["email"] == user.email
    assert set(body["roles"]) == {"ENGINEER", "MANAGER"}


def test_wrong_password_is_rejected_without_revealing_the_account(client, make_user):
    user, _ = make_user()

    known = client.post(
        "/api/v1/auth/login", json={"email": user.email, "password": "wrong"}
    )
    unknown = client.post(
        "/api/v1/auth/login", json={"email": "nobody@mrpl.local", "password": "wrong"}
    )

    assert known.status_code == unknown.status_code == 401
    assert known.json()["error"]["message"] == unknown.json()["error"]["message"]


def test_protected_route_requires_a_token(client):
    assert client.get("/api/v1/auth/me").status_code == 401
    assert (
        client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer not-a-token"}
        ).status_code
        == 401
    )
