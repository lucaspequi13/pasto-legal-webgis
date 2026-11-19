from app.rules import summarize, summary_text

from .conftest import square


def _snap():
    return {
        "paddocks": [
            {"id": "f_paddock_1", "number": 1, "name": None, "geometry": square(0, 0, 0.01, 0.01)},
            {"id": "f_paddock_2", "number": 2, "name": None, "geometry": square(0.01, 0, 0.02, 0.01)},
        ],
        "pins": [],
    }


def test_summary_counts_by_id():
    snap = _snap()
    content = {
        "paddocks": [
            {"id": "f_paddock_1", "number": 1, "name": "Represa", "geometry": square(0, 0, 0.01, 0.01)},
            {"id": None, "number": 3, "name": None, "geometry": square(0.02, 0, 0.03, 0.01)},
            {"id": None, "number": 4, "name": None, "geometry": square(0.03, 0, 0.04, 0.01)},
        ],
        "pins": [{"id": None, "kind": "bebedouro", "name": None, "lon": 0.005, "lat": 0.005}],
    }
    s = summarize(snap, content)
    assert (s["piquetes_novos"], s["piquetes_alterados"], s["piquetes_apagados"]) == (2, 1, 1)
    assert s["texto"] == ("2 piquetes novos, 1 piquete alterado, 1 piquete apagado "
                          "e 1 mudança nos alfinetes")


def test_no_changes():
    snap = _snap()
    s = summarize(snap, {"paddocks": snap["paddocks"], "pins": []})
    assert s["tem_mudancas"] is False and s["texto"] == "nenhuma mudança"


def test_summary_text_singular():
    c = dict.fromkeys(["piquetes_novos", "piquetes_alterados", "piquetes_apagados",
                       "alfinetes_novos", "alfinetes_alterados", "alfinetes_apagados"], 0)
    c["piquetes_novos"] = 1
    assert summary_text(c) == "1 piquete novo"
