import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, signal } from '@angular/core';
import OlMap from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import TileJSON from 'ol/source/TileJSON';
import { fromLonLat } from 'ol/proj';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { Fill, Stroke, Style, Text } from 'ol/style';
import type { FeatureLike } from 'ol/Feature';
import { environment } from '../../environments/environment';

// IDs do satélite no MapTiler, do mais novo para o mais antigo; usa o primeiro que existir.
const SATELITE_IDS = ['satellite-v2', 'satellite-v4', 'satellite'];
// Fazenda de teste exportada do Pasto Legal (dev) — ver webgis/scripts/exportar_fazenda.py
const FAZENDA_URL = 'fazenda-teste.geojson';

function estiloFeicao(feature: FeatureLike): Style {
  const tipo = feature.get('feature_type');
  if (tipo === 'rural_property') {
    // Cerca da fazenda: contínua, grossa, amarela, sem preenchimento
    return new Style({ stroke: new Stroke({ color: '#FFD60A', width: 4 }) });
  }
  // Piquetes: borda branca e preenchimento leve, com o nome no centro
  return new Style({
    stroke: new Stroke({ color: '#FFFFFF', width: 2 }),
    fill: new Fill({ color: 'rgba(255, 255, 255, 0.15)' }),
    text: new Text({
      text: String(feature.get('feature_id') ?? ''),
      font: 'bold 14px system-ui, sans-serif',
      fill: new Fill({ color: '#FFFFFF' }),
      stroke: new Stroke({ color: '#000000', width: 3 }),
    }),
  });
}

const tilejsonUrl = (id: string) =>
  `https://api.maptiler.com/tiles/${id}/tiles.json?key=${environment.maptilerKey}`;

@Component({
  selector: 'app-mapa',
  templateUrl: './mapa.html',
  styleUrl: './mapa.scss',
})
export class Mapa implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;
  private map?: OlMap;
  protected readonly aviso = signal<string | null>(null);

  ngAfterViewInit(): void {
    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [],
      view: new View({ center: fromLonLat([-49.25, -16.68]), zoom: 14 }),
    });
    this.carregarSatelite();
    this.carregarFazenda();
  }

  private async carregarFazenda(): Promise<void> {
    try {
      const resp = await fetch(FAZENDA_URL);
      if (!resp.ok) {
        this.aviso.set(`Não achei ${FAZENDA_URL} (${resp.status}). Rode webgis/scripts/exportar_fazenda.py.`);
        return;
      }
      const features = new GeoJSON().readFeatures(await resp.json(), {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      const source = new VectorSource({ features });
      this.map?.addLayer(new VectorLayer({ source, style: estiloFeicao, zIndex: 10 }));
      const extent = source.getExtent();
      if (extent) {
        this.map?.getView().fit(extent, { padding: [40, 40, 40, 40], maxZoom: 18 });
      }
    } catch (e) {
      this.aviso.set(`Erro ao carregar a fazenda: ${e}`);
    }
  }

  private async carregarSatelite(): Promise<void> {
    const erros: string[] = [];
    for (const id of SATELITE_IDS) {
      try {
        const resp = await fetch(tilejsonUrl(id));
        if (!resp.ok) {
          erros.push(`${id}: ${resp.status}`);
          continue;
        }
        console.info(`[mapa] satélite carregado: ${id}`);
        this.map?.addLayer(
          new TileLayer({ source: new TileJSON({ url: tilejsonUrl(id), crossOrigin: 'anonymous' }) }),
        );
        return;
      } catch (e) {
        erros.push(`${id}: ${e}`);
      }
    }
    this.aviso.set(`MapTiler não respondeu (${erros.join(' · ')}). Confira a chave e as origens permitidas.`);
  }

  ngOnDestroy(): void {
    this.map?.setTarget(undefined);
  }
}
