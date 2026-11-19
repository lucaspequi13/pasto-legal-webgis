from datetime import timedelta

from .conftest import KEY, square

H = {"X-Internal-Key": KEY}


def _link(client, snapshot, user="5562999990000"):
    r = client.post("/internal/links", json={"user_id": user, "snapshot": snapshot}, headers=H)
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert "#t=" in url  # token no fragmento, nunca em ?t=
    return url.split("#t=")[1], r.json()


def _save(client, token, version, paddocks, pins=()):
    return client.put(f"/links/{token}/draft",
                      json={"version": version, "paddocks": paddocks, "pins": list(pins)})


def test_internal_routes_need_the_key(client, snapshot):
    r = client.post("/internal/links", json={"user_id": "1", "snapshot": snapshot})
    assert r.status_code == 401


def test_full_flow_new_paddock_and_pin(client, snapshot):
    token, _ = _link(client, snapshot)
    view = client.get(f"/links/{token}").json()
    assert view["farm"]["name"] == "Boa Vista" and view["read_only"] is False

    paddocks = view["paddocks"] + [
        {"id": None, "number": 2, "name": "Pasto da Represa",
         "geometry": square(-49.295, -16.700, -49.290, -16.695)},
    ]
    pins = [{"id": None, "kind": "bebedouro", "name": "Bebedouro 1", "lon": -49.297, "lat": -16.697}]
    r = _save(client, token, view["version"], paddocks, pins)
    assert r.status_code == 200, r.text
    assert r.json()["paddocks"][1]["area_ha"] > 0

    assert client.post(f"/links/{token}/finish").json()["status"] == "enviado"
    # Depois de terminado, o mapa fica só leitura.
    assert client.get(f"/links/{token}").json()["read_only"] is True
    assert _save(client, token, 1, paddocks, pins).status_code == 409

    draft = client.get("/internal/drafts", params={"user_id": "5562999990000"}, headers=H).json()["draft"]
    assert draft["summary"]["piquetes_novos"] == 1
    assert draft["summary"]["texto"] == "1 piquete novo e 1 mudança nos alfinetes"

    r = client.post(f"/internal/drafts/{draft['id']}/status", params={"user_id": "5562999990000"},
                    json={"status": "confirmado"}, headers=H)
    assert r.json() == {"status": "confirmado", "changed": True}
    # "Sim" duplicado (webhook repetido) não confirma duas vezes.
    r = client.post(f"/internal/drafts/{draft['id']}/status", params={"user_id": "5562999990000"},
                    json={"status": "confirmado"}, headers=H)
    assert r.json()["changed"] is False
    assert client.get("/internal/drafts", params={"user_id": "5562999990000"}, headers=H).json()["draft"] is None


def test_stale_version_is_refused(client, snapshot):
    token, _ = _link(client, snapshot)
    v = client.get(f"/links/{token}").json()["version"]
    assert _save(client, token, v, snapshot["paddocks"]).status_code == 200
    # Outra aba ainda com a versão antiga.
    r = _save(client, token, v, snapshot["paddocks"])
    assert r.status_code == 409 and "outro lugar" in r.json()["detail"]


def test_fence_rules(client, snapshot):
    token, _ = _link(client, snapshot)
    # Um pouco fora (< 10%): corta no limite.
    slightly_out = square(-49.2909, -16.700, -49.28995, -16.699)  # ~5% fora
    r = _save(client, token, 0, [{"id": None, "number": 1, "name": None, "geometry": slightly_out}])
    assert r.status_code == 200, r.text
    assert r.json()["paddocks"][0]["geometry"]["coordinates"][0][0][1][0] <= -49.29  # cortado na cerca
    # Muito fora (>= 10%): recusa.
    far_out = square(-49.291, -16.700, -49.285, -16.695)
    r = _save(client, token, 1, [{"id": None, "number": 1, "name": None, "geometry": far_out}])
    assert r.status_code == 422 and "saiu da sua propriedade" in r.json()["detail"]


def test_overlap_and_pin_outside_are_refused(client, snapshot):
    token, _ = _link(client, snapshot)
    a = square(-49.300, -16.700, -49.295, -16.695)
    b = square(-49.297, -16.700, -49.292, -16.695)
    r = _save(client, token, 0, [{"id": None, "number": 1, "geometry": a},
                                 {"id": None, "number": 2, "geometry": b}])
    assert r.status_code == 422 and "por cima" in r.json()["detail"]
    pin_out = [{"kind": "outro", "name": "Nascente", "lon": -49.0, "lat": -16.0}]
    r = _save(client, token, 0, [], pin_out)
    assert r.status_code == 422 and "dentro da propriedade" in r.json()["detail"]


def test_self_intersecting_stroke_is_repaired(client, snapshot):
    token, _ = _link(client, snapshot)
    bowtie = {"type": "Polygon", "coordinates": [[
        [-49.300, -16.700], [-49.295, -16.695], [-49.295, -16.700], [-49.300, -16.695], [-49.300, -16.700]
    ]]}
    r = _save(client, token, 0, [{"id": None, "number": 1, "geometry": bowtie}])
    assert r.status_code == 200, r.text
    assert r.json()["paddocks"][0]["geometry"]["type"] == "MultiPolygon"


def test_new_link_replaces_previous_and_discards_draft(client, snapshot):
    old, _ = _link(client, snapshot)
    client.get(f"/links/{old}")
    _save(client, old, 0, snapshot["paddocks"])
    new, body = _link(client, snapshot)
    assert body["replaced_previous"] is True
    r = client.get(f"/links/{old}")
    assert r.status_code == 410 and "substituído" in r.json()["detail"]
    assert client.get(f"/links/{new}").status_code == 200
    # O rascunho antigo foi descartado: nada para confirmar.
    assert client.get("/internal/drafts", params={"user_id": "5562999990000"}, headers=H).json()["draft"] is None


def test_unopened_link_expires_but_opened_link_stays(client, snapshot):
    token, _ = _link(client, snapshot)
    opened, _ = _link(client, snapshot, user="5562888880000")
    client.get(f"/links/{opened}")
    with client.app_state.db.connection() as conn:
        conn.execute("UPDATE webgis.links SET expires_at = expires_at - %s", (timedelta(minutes=10),))
    r = client.get(f"/links/{token}")
    assert r.status_code == 410 and "Tempo expirado" in r.json()["detail"]
    assert client.get(f"/links/{opened}").status_code == 200


def test_message_in_chat_counts_as_finished(client, snapshot):
    token, _ = _link(client, snapshot)
    _save(client, token, 0, snapshot["paddocks"][:0])  # apagou o piquete, sem "Terminei"
    draft = client.get("/internal/drafts", params={"user_id": "5562999990000"}, headers=H).json()["draft"]
    assert draft["status"] == "rascunho" and draft["summary"]["piquetes_apagados"] == 1
    r = client.post(f"/internal/drafts/{draft['id']}/status", params={"user_id": "5562999990000"},
                    json={"status": "enviado"}, headers=H)
    assert r.json()["changed"] is True
    assert client.get(f"/links/{token}").json()["read_only"] is True


def test_idle_job_finishes_only_edited_drafts(client, snapshot):
    untouched, _ = _link(client, snapshot, user="1")
    edited, _ = _link(client, snapshot, user="2")
    _save(client, edited, 0, snapshot["paddocks"])
    with client.app_state.db.connection() as conn:
        conn.execute("UPDATE webgis.drafts SET updated_at = updated_at - %s", (timedelta(minutes=11),))
    finished = client.app_state.finish_idle()
    assert len(finished) == 1
    assert client.get(f"/links/{edited}").json()["read_only"] is True
    assert client.get(f"/links/{untouched}").json()["read_only"] is False


def test_owner_is_hmac_and_lgpd_delete(client, snapshot):
    token, _ = _link(client, snapshot)
    with client.app_state.db.connection() as conn:
        owner = conn.execute("SELECT owner FROM webgis.links").fetchone()["owner"]
    assert "5562999990000" not in owner and len(owner) == 64
    r = client.delete("/internal/owners/5562999990000", headers=H)
    assert r.json()["deleted_links"] == 1
    assert client.get(f"/links/{token}").status_code == 404


def test_no_changes_means_nothing_to_confirm(client, snapshot):
    token, _ = _link(client, snapshot)
    v = client.get(f"/links/{token}").json()["version"]
    _save(client, token, v, snapshot["paddocks"])  # salvou igual ao que veio do chat
    client.post(f"/links/{token}/finish")
    draft = client.get("/internal/drafts", params={"user_id": "5562999990000"}, headers=H).json()["draft"]
    assert draft is None
