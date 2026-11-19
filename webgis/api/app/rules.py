"""Regras de desenho no servidor (mesmas do front, em webgis/frontend/src/app/mapa/regras.ts).

O navegador aplica as regras na hora; aqui elas são refeitas antes de gravar,
para um navegador alterado não gravar geometria errada. O servidor manda:
devolve a geometria corrigida e o mapa redesenha.

- Cerca: abaixo de 10% fora, corta no limite; a partir de 10%, recusa.
- Sobreposição entre piquetes acima de 1 m²: recusa (o front já fatia).
- Traço inválido (cruza a si mesmo): make_valid.
- Área em hectares calculada no elipsoide (pyproj), não em graus.
"""

from dataclasses import dataclass

from pyproj import Geod
from shapely import make_valid
from shapely.geometry import MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import unary_union

GEOD = Geod(ellps="WGS84")
AREA_MINIMA_M2 = 1.0
LIMITE_FORA = 0.10
MAX_VERTICES = 2000


class RuleError(ValueError):
    """Desenho recusado; a mensagem é em pt-BR e pode ir para a tela."""


def area_m2(geom) -> float:
    return abs(GEOD.geometry_area_perimeter(geom)[0])


def area_ha(geom) -> float:
    return round(area_m2(geom) / 10_000, 4)


def _polygonal(geom):
    """Fica só com a parte poligonal (make_valid pode devolver linhas soltas)."""
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if isinstance(g, (Polygon, MultiPolygon))]
    return unary_union(parts) if parts else Polygon()


def as_multipolygon(geom) -> MultiPolygon:
    geom = _polygonal(geom)
    if isinstance(geom, Polygon):
        return MultiPolygon([geom]) if not geom.is_empty else MultiPolygon()
    return geom


def clean(geometry: dict):
    geom = shape(geometry)
    if not geom.is_valid:
        geom = make_valid(geom)
    geom = _polygonal(geom)
    vertices = sum(len(p.exterior.coords) for p in as_multipolygon(geom).geoms)
    if vertices > MAX_VERTICES:
        raise RuleError("O desenho tem pontos demais. Desenhe de novo, com um traço mais simples.")
    return geom


def apply_fence(paddock, fence):
    """Aplica a regra da cerca. Devolve a geometria (cortada se preciso)."""
    total = area_m2(paddock)
    if total < AREA_MINIMA_M2:
        raise RuleError("O piquete ficou pequeno demais.")
    inside = paddock.intersection(fence)
    inside_area = area_m2(inside) if not inside.is_empty else 0.0
    outside = max(0.0, 1 - inside_area / total)
    if outside >= LIMITE_FORA:
        raise RuleError("Você saiu da sua propriedade. Desenhe novamente dentro dela.")
    return _polygonal(inside) if outside > 0.0005 else paddock


@dataclass
class CheckedDraft:
    content: dict
    warnings: list


def check_draft(fence_geojson: dict, content: dict, max_paddocks: int) -> CheckedDraft:
    """Valida e corrige o rascunho inteiro. Levanta RuleError se recusar."""
    fence = clean(fence_geojson)
    paddocks_in = content.get("paddocks") or []
    pins_in = content.get("pins") or []
    if len(paddocks_in) > max_paddocks:
        raise RuleError(f"Limite de {max_paddocks} piquetes por fazenda.")

    numbers = [p.get("number") for p in paddocks_in]
    if any(not isinstance(n, int) or n < 1 for n in numbers) or len(set(numbers)) != len(numbers):
        raise RuleError("Numeração de piquetes inválida. Recarregue o mapa.")

    warnings, paddocks_out, geoms = [], [], []
    for p in paddocks_in:
        geom = apply_fence(clean(p["geometry"]), fence)
        for other_number, other in geoms:
            overlap = geom.intersection(other)
            if not overlap.is_empty and area_m2(overlap) > AREA_MINIMA_M2:
                raise RuleError(
                    f"O Piquete {p['number']} está por cima do Piquete {other_number}. Recarregue o mapa."
                )
        geoms.append((p["number"], geom))
        mp = as_multipolygon(geom)
        paddocks_out.append({
            "id": p.get("id"),
            "number": p["number"],
            "name": (p.get("name") or "").strip() or None,
            "geometry": mapping(mp),
            "area_ha": area_ha(mp),
        })

    pins_out = []
    for pin in pins_in:
        if pin.get("kind") not in ("bebedouro", "outro"):
            raise RuleError("Tipo de alfinete inválido.")
        if not fence.covers(Point(pin["lon"], pin["lat"])):
            raise RuleError("O alfinete precisa ficar dentro da propriedade.")
        pins_out.append({
            "id": pin.get("id"),
            "kind": pin["kind"],
            "name": (pin.get("name") or "").strip() or None,
            "lon": float(pin["lon"]),
            "lat": float(pin["lat"]),
        })

    return CheckedDraft({"paddocks": paddocks_out, "pins": pins_out}, warnings)


def _same_geometry(a: dict, b: dict) -> bool:
    ga, gb = shape(a), shape(b)
    diff = ga.symmetric_difference(gb)
    return diff.is_empty or area_m2(diff) <= AREA_MINIMA_M2


def summarize(snapshot: dict, content: dict) -> dict:
    """Conta o que mudou entre o snapshot do chat e o rascunho (por id).

    Os números vão prontos para o texto da tool (o modelo nunca conta: BUG-015).
    """
    before = {p["id"]: p for p in snapshot.get("paddocks", []) if p.get("id")}
    after_ids = {p.get("id") for p in content.get("paddocks", []) if p.get("id")}
    new = [p for p in content.get("paddocks", []) if not p.get("id")]
    changed = [
        p for p in content.get("paddocks", [])
        if p.get("id") in before and (
            not _same_geometry(before[p["id"]]["geometry"], p["geometry"])
            or (before[p["id"]].get("name") or None) != (p.get("name") or None)
        )
    ]
    deleted = [p for pid, p in before.items() if pid not in after_ids]

    pins_before = {p["id"]: p for p in snapshot.get("pins", []) if p.get("id")}
    pins_after = {p.get("id") for p in content.get("pins", []) if p.get("id")}
    pins_new = [p for p in content.get("pins", []) if not p.get("id")]
    pins_changed = [
        p for p in content.get("pins", [])
        if p.get("id") in pins_before and any(
            pins_before[p["id"]].get(k) != p.get(k) for k in ("kind", "name", "lon", "lat")
        )
    ]
    pins_deleted = [p for pid, p in pins_before.items() if pid not in pins_after]

    counts = {
        "piquetes_novos": len(new),
        "piquetes_alterados": len(changed),
        "piquetes_apagados": len(deleted),
        "alfinetes_novos": len(pins_new),
        "alfinetes_alterados": len(pins_changed),
        "alfinetes_apagados": len(pins_deleted),
    }
    counts["texto"] = summary_text(counts)
    counts["tem_mudancas"] = any(v for k, v in counts.items() if k != "texto")
    return counts


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def summary_text(c: dict) -> str:
    parts = []
    if c["piquetes_novos"]:
        parts.append(_plural(c["piquetes_novos"], "piquete novo", "piquetes novos"))
    if c["piquetes_alterados"]:
        parts.append(_plural(c["piquetes_alterados"], "piquete alterado", "piquetes alterados"))
    if c["piquetes_apagados"]:
        parts.append(_plural(c["piquetes_apagados"], "piquete apagado", "piquetes apagados"))
    pins = c["alfinetes_novos"] + c["alfinetes_alterados"] + c["alfinetes_apagados"]
    if pins:
        parts.append(_plural(pins, "mudança nos alfinetes", "mudanças nos alfinetes"))
    if not parts:
        return "nenhuma mudança"
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " e " + parts[-1]
