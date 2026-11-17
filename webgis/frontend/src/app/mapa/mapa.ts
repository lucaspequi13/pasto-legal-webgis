import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, signal } from '@angular/core';
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
import Draw from 'ol/interaction/Draw';
import Snap from 'ol/interaction/Snap';
import Select from 'ol/interaction/Select';
import { click } from 'ol/events/condition';
import { getArea } from 'ol/sphere';
import { environment } from '../../environments/environment';

// IDs do satélite no MapTiler, do mais novo para o mais antigo; usa o primeiro que existir.
const SATELITE_IDS = ['satellite-v2', 'satellite-v4', 'satellite'];
// Fazenda de teste exportada do Pasto Legal (dev) — ver webgis/scripts/exportar_fazenda.py
const FAZENDA_URL = 'fazenda-teste.geojson';

/** Nome exibido: o nome próprio dado pelo produtor, ou o padrão "Piquete n". */
function rotuloPiquete(feature: FeatureLike): string {
  const nome = feature.get('name');
  return nome ? String(nome) : `Piquete ${feature.get('display_number') ?? '?'}`;
}

/** Nome automático que o cadastro por arquivo gera hoje (ex.: "Paddock_3"). */
const NOME_PADRAO_ARQUIVO = /^Paddock_(\d+)$/;

/** Piquete selecionado: borda laranja grossa, preenchimento mais forte, desenhado por cima dos outros. */
function estiloSelecionado(feature: FeatureLike): Style {
  return new Style({
    stroke: new Stroke({ color: '#FF8A00', width: 4 }),
    fill: new Fill({ color: 'rgba(255, 138, 0, 0.35)' }),
    text: new Text({
      text: rotuloPiquete(feature),
      overflow: true,
      font: 'bold 16px system-ui, sans-serif',
      fill: new Fill({ color: '#FFFFFF' }),
      stroke: new Stroke({ color: '#000000', width: 4 }),
    }),
    zIndex: 100,
  });
}

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
      text: rotuloPiquete(feature),
      overflow: true, // mostra o nome mesmo se o polígono for estreito
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
  /** Fonte com a cerca e os piquetes (os existentes e os desenhados). */
  private readonly fonte = new VectorSource();
  private draw?: Draw;
  private snap?: Snap;
  protected readonly aviso = signal<string | null>(null);
  protected readonly desenhando = signal(false);
  /** Piquete tocado: nome e área para mostrar na tela. */
  protected readonly selecionado = signal<{ nome: string; areaHa: string } | null>(null);
  private select?: Select;

  ngAfterViewInit(): void {
    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [],
      view: new View({ center: fromLonLat([-49.25, -16.68]), zoom: 14 }),
    });
    this.carregarSatelite();
    this.carregarFazenda();
    this.ativarSelecao();
  }

  /**
   * Destaque da seleção (DDS, seção 5): o piquete tocado fica destacado e por cima;
   * o anterior perde o destaque. A cerca da fazenda não é selecionável.
   */
  private ativarSelecao(): void {
    this.select = new Select({
      condition: click,
      style: estiloSelecionado,
      filter: (f) => f.get('feature_type') === 'paddock',
      hitTolerance: 4,
    });
    this.select.on('select', () => {
      const f = this.select?.getFeatures().item(0);
      if (!f) {
        this.selecionado.set(null);
        return;
      }
      const geom = f.getGeometry();
      const ha = geom ? getArea(geom) / 10_000 : 0;
      this.selecionado.set({ nome: rotuloPiquete(f), areaHa: ha.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) });
    });
    this.map?.addInteraction(this.select);

    // Cursor de "mãozinha" ao passar sobre um piquete
    this.map?.on('pointermove', (evt) => {
      if (this.desenhando()) return;
      const sobre = this.map!.forEachFeatureAtPixel(
        evt.pixel,
        (f) => (f.get('feature_type') === 'paddock' ? true : undefined),
        { hitTolerance: 4 },
      );
      const alvo = this.map!.getTargetElement();
      if (alvo) alvo.style.cursor = sobre ? 'pointer' : '';
    });
  }

  protected limparSelecao(): void {
    this.select?.getFeatures().clear();
    this.selecionado.set(null);
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
      this.numerarPiquetes(features);
      this.fonte.addFeatures(features);
      this.map?.addLayer(new VectorLayer({ source: this.fonte, style: estiloFeicao, zIndex: 10 }));
      const extent = this.fonte.getExtent();
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

  /**
   * "Piquete n" por ordem de inserção, contado por fazenda (regra do líder, 06/11).
   * - "Paddock_3" (nome automático do cadastro por arquivo) vira número 3, sem nome próprio.
   * - Qualquer outro nome é nome próprio do produtor e é mantido; ganha o próximo número livre.
   * O número fica gravado e nunca é reaproveitado.
   */
  private numerarPiquetes(features: FeatureLike[]): void {
    const piquetes = features.filter((f) => f.get('feature_type') === 'paddock');
    const semNumero: FeatureLike[] = [];
    for (const f of piquetes) {
      const id = String(f.get('feature_id') ?? '');
      const m = NOME_PADRAO_ARQUIVO.exec(id);
      if (m) {
        (f as any).set('display_number', Number(m[1]));
      } else {
        if (id) (f as any).set('name', id);
        semNumero.push(f);
      }
    }
    for (const f of semNumero) (f as any).set('display_number', this.proximoNumero(piquetes));
  }

  /** Próximo número livre na fazenda: maior número já usado + 1. */
  private proximoNumero(piquetes: FeatureLike[] = this.fonte.getFeatures()): number {
    let maior = 0;
    for (const f of piquetes) {
      if (f.get('feature_type') !== 'paddock') continue;
      maior = Math.max(maior, Number(f.get('display_number') ?? 0));
    }
    return maior + 1;
  }

  /** Fase 3: desenhar um piquete novo, ponto a ponto; duplo clique fecha. */
  protected iniciarDesenho(): void {
    if (!this.map || this.desenhando()) return;
    this.limparSelecao();
    this.select?.setActive(false);
    this.draw = new Draw({ type: 'Polygon' });
    this.draw.on('drawend', (evt) => {
      evt.feature.set('feature_type', 'paddock');
      evt.feature.set('display_number', this.proximoNumero());
      this.fonte.addFeature(evt.feature);
      this.encerrarDesenho();
    });
    // O Snap precisa ser adicionado DEPOIS do Draw: gruda na cerca e nos piquetes vizinhos.
    this.snap = new Snap({ source: this.fonte, pixelTolerance: 12 });
    this.map.addInteraction(this.draw);
    this.map.addInteraction(this.snap);
    this.desenhando.set(true);
  }

  @HostListener('document:keydown.escape')
  protected cancelarDesenho(): void {
    this.draw?.abortDrawing();
    this.encerrarDesenho();
  }

  /** Desfaz o último ponto clicado (atalho: Backspace). */
  @HostListener('document:keydown.backspace')
  protected desfazerPonto(): void {
    if (this.desenhando()) this.draw?.removeLastPoint();
  }

  private encerrarDesenho(): void {
    if (this.draw) this.map?.removeInteraction(this.draw);
    if (this.snap) this.map?.removeInteraction(this.snap);
    this.draw = undefined;
    this.snap = undefined;
    this.desenhando.set(false);
    this.select?.setActive(true);
  }

  ngOnDestroy(): void {
    this.map?.setTarget(undefined);
  }
}
