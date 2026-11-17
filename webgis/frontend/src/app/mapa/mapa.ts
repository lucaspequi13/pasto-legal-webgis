import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, ViewChild, signal } from '@angular/core';
import OlMap from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import type { FeatureLike } from 'ol/Feature';
import type Geometry from 'ol/geom/Geometry';
import TileLayer from 'ol/layer/Tile';
import TileJSON from 'ol/source/TileJSON';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { fromLonLat } from 'ol/proj';
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style';
import Draw from 'ol/interaction/Draw';
import Snap from 'ol/interaction/Snap';
import Select from 'ol/interaction/Select';
import Modify from 'ol/interaction/Modify';
import { click } from 'ol/events/condition';
import type { Feature as GjFeature, Point as GjPoint } from 'geojson';
import { environment } from '../../environments/environment';
import { Poligono, aplicarCerca, areaHa, diferenca, interseccao, partes, pontoDentro } from './regras';

// IDs do satélite no MapTiler, do mais novo para o mais antigo; usa o primeiro que existir.
const SATELITE_IDS = ['satellite-v2', 'satellite-v4', 'satellite'];
// Fazenda de teste exportada do Pasto Legal (dev) — ver webgis/scripts/exportar_fazenda.py
const FAZENDA_URL = 'fazenda-teste.geojson';
/** Nome automático que o cadastro por arquivo gera hoje (ex.: "Paddock_3"). */
const NOME_PADRAO_ARQUIVO = /^Paddock_(\d+)$/;

const tilejsonUrl = (id: string) =>
  `https://api.maptiler.com/tiles/${id}/tiles.json?key=${environment.maptilerKey}`;

type TipoAlfinete = 'bebedouro' | 'outro';

// ---------- rótulos e estilos ----------

/** Código do CAR (ex.: "GO-5208707-ABC…"). */
const PADRAO_CAR = /^[A-Z]{2}-\d{7}-[0-9A-F.]+$/i;

/**
 * Nome da fazenda no topo (DDS, seção 5): o nome dado pelo produtor; sem nome,
 * o CAR abreviado (5 primeiros … 5 últimos); sem CAR, "Fazenda A".
 */
function nomeFazenda(f: FeatureLike): string {
  const nome = f.get('name');
  if (nome) return String(nome);
  const id = String(f.get('feature_id') ?? '');
  if (PADRAO_CAR.test(id)) return `${id.slice(0, 5)}…${id.slice(-5)}`;
  return 'Fazenda A';
}

/** Nome exibido: o nome próprio, ou o padrão ("Piquete n" / "Bebedouro"). */
function rotulo(f: FeatureLike): string {
  const nome = f.get('name');
  if (nome) return String(nome);
  if (f.get('feature_type') === 'pin') return f.get('pin_type') === 'outro' ? 'Alfinete' : 'Bebedouro';
  return `Piquete ${f.get('display_number') ?? '?'}`;
}

function texto(f: FeatureLike, tamanho: number, deslocY = 0): Text {
  return new Text({
    text: rotulo(f),
    overflow: true,
    offsetY: deslocY,
    font: `bold ${tamanho}px system-ui, sans-serif`,
    fill: new Fill({ color: '#FFFFFF' }),
    stroke: new Stroke({ color: '#000000', width: 3 }),
  });
}

function estiloAlfinete(f: FeatureLike, selecionado: boolean): Style {
  const cor = selecionado ? '#FF8A00' : f.get('pin_type') === 'outro' ? '#8E44AD' : '#1E88E5';
  return new Style({
    image: new CircleStyle({
      radius: selecionado ? 10 : 8,
      fill: new Fill({ color: cor }),
      stroke: new Stroke({ color: '#FFFFFF', width: 3 }),
    }),
    text: texto(f, 13, -20),
    zIndex: selecionado ? 200 : 50,
  });
}

function estiloFeicao(f: FeatureLike): Style {
  const tipo = f.get('feature_type');
  if (tipo === 'rural_property') {
    return new Style({ stroke: new Stroke({ color: '#FFD60A', width: 4 }) }); // cerca
  }
  if (tipo === 'pin') return estiloAlfinete(f, false);
  return new Style({
    stroke: new Stroke({ color: '#FFFFFF', width: 2 }),
    fill: new Fill({ color: 'rgba(255, 255, 255, 0.15)' }),
    text: texto(f, 14),
  });
}

/** Selecionado: laranja, mais forte e por cima dos outros. */
function estiloSelecionado(f: FeatureLike): Style {
  if (f.get('feature_type') === 'pin') return estiloAlfinete(f, true);
  return new Style({
    stroke: new Stroke({ color: '#FF8A00', width: 4 }),
    fill: new Fill({ color: 'rgba(255, 138, 0, 0.35)' }),
    text: texto(f, 16),
    zIndex: 100,
  });
}

// ---------- componente ----------

interface InfoSelecionado {
  tipo: 'paddock' | 'pin';
  rotulo: string;
  nome: string;
  padrao: string;
  areaHa?: string;
  pinType?: TipoAlfinete;
}

interface Resumo {
  novos: string[];
  alterados: string[];
  apagados: string[];
  alfinetes: string[];
  geojson: string;
}

@Component({
  selector: 'app-mapa',
  templateUrl: './mapa.html',
  styleUrl: './mapa.scss',
})
export class Mapa implements AfterViewInit, OnDestroy {
  @ViewChild('mapEl', { static: true }) mapEl!: ElementRef<HTMLDivElement>;

  private map?: OlMap;
  /** Cerca, piquetes e alfinetes (os da fazenda e os desenhados). */
  private readonly fonte = new VectorSource();
  /** Converte entre o mapa (EPSG:3857) e o GeoJSON/Turf (EPSG:4326). */
  private readonly fmt = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });

  private select?: Select;
  private modify?: Modify;
  private snapEdicao?: Snap;
  private draw?: Draw;
  private snapDesenho?: Snap;

  /** Maior número de piquete já usado nesta fazenda (nunca é reaproveitado). */
  private ultimoNumero = 0;
  /** Como a fazenda chegou do chat, para montar o resumo do "Terminei". */
  private inicial = new Map<string, { rotulo: string; geom: string }>();

  protected readonly fazenda = signal<{ nome: string; areaHa: string } | null>(null);
  protected readonly aviso = signal<string | null>(null);
  protected readonly nota = signal<string | null>(null);
  protected readonly modo = signal<'parado' | 'piquete' | 'alfinete'>('parado');
  protected readonly selecionado = signal<InfoSelecionado | null>(null);
  protected readonly resumo = signal<Resumo | null>(null);
  private notaTimer?: ReturnType<typeof setTimeout>;

  ngAfterViewInit(): void {
    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [new VectorLayer({ source: this.fonte, style: estiloFeicao, zIndex: 10 })],
      view: new View({ center: fromLonLat([-49.25, -16.68]), zoom: 14 }),
    });
    this.carregarSatelite();
    this.carregarFazenda();
    this.ativarEdicao();
  }

  ngOnDestroy(): void {
    clearTimeout(this.notaTimer);
    this.map?.setTarget(undefined);
  }

  // ---------- carregamento ----------

  private async carregarSatelite(): Promise<void> {
    const erros: string[] = [];
    for (const id of SATELITE_IDS) {
      try {
        const resp = await fetch(tilejsonUrl(id));
        if (!resp.ok) {
          erros.push(`${id}: ${resp.status}`);
          continue;
        }
        this.map?.addLayer(
          new TileLayer({ source: new TileJSON({ url: tilejsonUrl(id), crossOrigin: 'anonymous' }), zIndex: 0 }),
        );
        return;
      } catch (e) {
        erros.push(`${id}: ${e}`);
      }
    }
    this.aviso.set(`MapTiler não respondeu (${erros.join(' · ')}). Confira a chave e as origens permitidas.`);
  }

  private async carregarFazenda(): Promise<void> {
    try {
      const resp = await fetch(FAZENDA_URL);
      if (!resp.ok) {
        this.aviso.set(`Não achei ${FAZENDA_URL} (${resp.status}). Rode webgis/scripts/exportar_fazenda.py.`);
        return;
      }
      const features = this.fmt.readFeatures(await resp.json()) as Feature<Geometry>[];
      this.numerarPiquetes(features);
      features.forEach((f, i) => f.setId(`chat-${i}`));
      this.fonte.addFeatures(features);
      for (const f of features) {
        if (f.get('feature_type') === 'rural_property') continue;
        this.inicial.set(String(f.getId()), { rotulo: rotulo(f), geom: this.geomTexto(f) });
      }
      const propriedade = features.find((f) => f.get('feature_type') === 'rural_property');
      if (propriedade) {
        const ha = areaHa(this.poly(propriedade));
        this.fazenda.set({
          nome: nomeFazenda(propriedade),
          areaHa: ha.toLocaleString('pt-BR', { maximumFractionDigits: 0 }),
        });
      }
      const extent = this.fonte.getExtent();
      if (extent) this.map?.getView().fit(extent, { padding: [60, 60, 120, 60], maxZoom: 18 });
    } catch (e) {
      this.aviso.set(`Erro ao carregar a fazenda: ${e}`);
    }
  }

  /**
   * "Piquete n" por ordem de inserção, contado por fazenda (regra do líder, 06/11).
   * "Paddock_3" (nome automático do cadastro por arquivo) vira número 3; outro nome é nome próprio
   * e é mantido, ganhando o próximo número livre.
   */
  private numerarPiquetes(features: Feature<Geometry>[]): void {
    const semNumero: Feature<Geometry>[] = [];
    for (const f of features) {
      if (f.get('feature_type') !== 'paddock') continue;
      const id = String(f.get('feature_id') ?? '');
      const m = NOME_PADRAO_ARQUIVO.exec(id);
      if (m) {
        f.set('display_number', Number(m[1]));
        this.ultimoNumero = Math.max(this.ultimoNumero, Number(m[1]));
      } else {
        if (id) f.set('name', id);
        semNumero.push(f);
      }
    }
    for (const f of semNumero) f.set('display_number', this.proximoNumero());
  }

  private proximoNumero(): number {
    return ++this.ultimoNumero;
  }

  // ---------- conversões ----------

  private poly(f: Feature<Geometry>): Poligono {
    return this.fmt.writeFeatureObject(f) as unknown as Poligono;
  }

  private geom(p: Poligono): Geometry {
    const g = this.fmt.readGeometry(p.geometry);
    if (!g) throw new Error('Geometria inválida');
    return g;
  }

  private geomTexto(f: Feature<Geometry>): string {
    const g = f.getGeometry();
    return g ? this.fmt.writeGeometry(g, { decimals: 7 }) : '';
  }

  private cerca(): Poligono | null {
    const f = this.fonte.getFeatures().find((x) => x.get('feature_type') === 'rural_property');
    return f ? this.poly(f) : null;
  }

  private piquetes(exceto?: Feature<Geometry>): Feature<Geometry>[] {
    return this.fonte.getFeatures().filter((f) => f.get('feature_type') === 'paddock' && f !== exceto);
  }

  // ---------- regras (Fase 4) ----------

  private novoPiquete(p: Poligono): Feature<Geometry> {
    const f = new Feature<Geometry>(this.geom(p));
    f.set('feature_type', 'paddock');
    f.set('display_number', this.proximoNumero());
    this.fonte.addFeature(f);
    return f;
  }

  /**
   * Aplica cerca e sobreposição ao piquete `f` (já no mapa).
   * Devolve false se o desenho deve ser recusado.
   */
  private aplicarRegras(f: Feature<Geometry>): boolean {
    const cerca = this.cerca();
    const mensagens: string[] = [];

    if (cerca) {
      const r = aplicarCerca(this.poly(f), cerca);
      if (r.tipo === 'recusado') {
        const pct = Math.round(r.fracaoFora * 100);
        this.mostrarNota(`Desenhe novamente dentro da sua propriedade (${pct}% ficou fora da cerca).`);
        return false;
      }
      if (r.ajustado) {
        f.setGeometry(this.geom(r.geom));
        mensagens.push('Uma parte passou da cerca e voltou para o limite.');
      }
    }

    // Sobreposição: vira fatias. O maior pedaço de cada piquete antigo mantém o número;
    // a parte em comum nasce como piquete novo.
    let atual: Poligono | null = this.poly(f);
    let cruzou = false;
    for (const vizinho of this.piquetes(f)) {
      if (!atual) break;
      const v = this.poly(vizinho);
      const comum = interseccao(atual, v);
      if (!comum) continue;
      cruzou = true;
      const restoVizinho = diferenca(v, atual);
      if (restoVizinho) {
        const [maior, ...extras] = partes(restoVizinho);
        vizinho.setGeometry(this.geom(maior));
        extras.forEach((p) => this.novoPiquete(p));
        partes(comum).forEach((p) => this.novoPiquete(p));
      }
      // Se o vizinho estava inteiro dentro do novo, ele fica como está e só sai do novo.
      atual = diferenca(atual, v);
    }

    if (!atual) {
      this.fonte.removeFeature(f); // o desenho virou só partes em comum
    } else if (cruzou) {
      const [maior, ...extras] = partes(atual);
      f.setGeometry(this.geom(maior));
      extras.forEach((p) => this.novoPiquete(p));
    }
    if (cruzou) mensagens.push('Cruzou outro piquete: as partes viraram piquetes menores.');
    if (mensagens.length) this.mostrarNota(mensagens.join(' '));
    return true;
  }

  // ---------- seleção e edição (Fase 5) ----------

  private ativarEdicao(): void {
    if (!this.map) return;
    this.select = new Select({
      condition: click,
      style: estiloSelecionado,
      filter: (f) => f.get('feature_type') === 'paddock' || f.get('feature_type') === 'pin',
      hitTolerance: 5,
    });
    this.select.on('select', () => this.atualizarCartao());

    // Editar: arrastar vértices do piquete (ou mover o alfinete) selecionado.
    this.modify = new Modify({ features: this.select.getFeatures() });
    const originais = new Map<Feature<Geometry>, Geometry>();
    this.modify.on('modifystart', (e) =>
      e.features.forEach((f) => {
        const g = (f as Feature<Geometry>).getGeometry();
        if (g) originais.set(f as Feature<Geometry>, g.clone());
      }),
    );
    this.modify.on('modifyend', (e) => {
      e.features.forEach((x) => {
        const f = x as Feature<Geometry>;
        const ok = f.get('feature_type') === 'pin' ? this.alfineteDentro(f) : this.aplicarRegras(f);
        const original = originais.get(f);
        if (!ok && original) f.setGeometry(original);
      });
      originais.clear();
      this.atualizarCartao();
    });

    // O Snap precisa vir DEPOIS do Modify/Draw.
    this.snapEdicao = new Snap({ source: this.fonte, pixelTolerance: 12 });
    this.map.addInteraction(this.select);
    this.map.addInteraction(this.modify);
    this.map.addInteraction(this.snapEdicao);

    this.map.on('pointermove', (evt) => {
      if (this.modo() !== 'parado' || !this.map) return;
      const sobre = this.map.forEachFeatureAtPixel(
        evt.pixel,
        (f) => (f.get('feature_type') === 'paddock' || f.get('feature_type') === 'pin' ? true : undefined),
        { hitTolerance: 5 },
      );
      const alvo = this.map.getTargetElement();
      if (alvo) alvo.style.cursor = sobre ? 'pointer' : '';
    });
  }

  private selecionadoAtual(): Feature<Geometry> | undefined {
    return this.select?.getFeatures().item(0) as Feature<Geometry> | undefined;
  }

  private atualizarCartao(): void {
    const f = this.selecionadoAtual();
    if (!f || !this.fonte.hasFeature(f)) {
      this.selecionado.set(null);
      return;
    }
    if (f.get('feature_type') === 'pin') {
      this.selecionado.set({
        tipo: 'pin',
        rotulo: rotulo(f),
        nome: f.get('name') ?? '',
        padrao: f.get('pin_type') === 'outro' ? 'Alfinete' : 'Bebedouro',
        pinType: f.get('pin_type') ?? 'bebedouro',
      });
      return;
    }
    const ha = areaHa(this.poly(f));
    this.selecionado.set({
      tipo: 'paddock',
      rotulo: rotulo(f),
      nome: f.get('name') ?? '',
      padrao: `Piquete ${f.get('display_number')}`,
      areaHa: ha.toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
    });
  }

  protected limparSelecao(): void {
    this.select?.getFeatures().clear();
    this.selecionado.set(null);
  }

  protected renomear(valor: string): void {
    const f = this.selecionadoAtual();
    if (!f) return;
    f.set('name', valor.trim() || undefined); // vazio volta para o nome padrão
    this.atualizarCartao();
  }

  protected mudarTipoAlfinete(valor: string): void {
    const f = this.selecionadoAtual();
    if (!f) return;
    f.set('pin_type', valor === 'outro' ? 'outro' : 'bebedouro');
    this.atualizarCartao();
  }

  protected apagarSelecionado(): void {
    const f = this.selecionadoAtual();
    if (!f) return;
    this.limparSelecao();
    this.fonte.removeFeature(f); // o número não é reaproveitado
    this.mostrarNota(`${rotulo(f)} apagado.`);
  }

  // ---------- desenhar piquete e alfinete ----------

  protected iniciarPiquete(): void {
    this.iniciarDesenho('piquete');
  }

  protected iniciarAlfinete(): void {
    this.iniciarDesenho('alfinete');
  }

  private iniciarDesenho(tipo: 'piquete' | 'alfinete'): void {
    if (!this.map || this.modo() !== 'parado') return;
    this.limparSelecao();
    this.select?.setActive(false);
    this.modify?.setActive(false);

    this.draw = new Draw({ type: tipo === 'piquete' ? 'Polygon' : 'Point' });
    this.draw.on('drawend', (evt) => {
      const f = evt.feature as Feature<Geometry>;
      // Deixa o OpenLayers terminar o evento antes de mexer na fonte.
      setTimeout(() => (tipo === 'piquete' ? this.concluirPiquete(f) : this.concluirAlfinete(f)));
      this.encerrarDesenho();
    });
    this.snapDesenho = new Snap({ source: this.fonte, pixelTolerance: 12 });
    this.map.addInteraction(this.draw);
    this.map.addInteraction(this.snapDesenho);
    this.modo.set(tipo);
  }

  private concluirPiquete(f: Feature<Geometry>): void {
    f.set('feature_type', 'paddock');
    f.set('display_number', this.proximoNumero());
    this.fonte.addFeature(f);
    if (!this.aplicarRegras(f)) {
      this.fonte.removeFeature(f);
      this.ultimoNumero--; // recusado: o número volta a ficar livre
      return;
    }
    if (this.fonte.hasFeature(f)) this.selecionar(f);
  }

  private concluirAlfinete(f: Feature<Geometry>): void {
    f.set('feature_type', 'pin');
    f.set('pin_type', 'bebedouro');
    if (!this.alfineteDentro(f)) return;
    this.fonte.addFeature(f);
    this.selecionar(f); // abre o cartão para escolher tipo e nome
  }

  private alfineteDentro(f: Feature<Geometry>): boolean {
    const cerca = this.cerca();
    if (!cerca) return true;
    const ponto = this.fmt.writeFeatureObject(f) as unknown as GjFeature<GjPoint>;
    if (pontoDentro(ponto, cerca)) return true;
    this.mostrarNota('O alfinete precisa ficar dentro da sua propriedade.');
    return false;
  }

  private selecionar(f: Feature<Geometry>): void {
    this.select?.getFeatures().clear();
    this.select?.getFeatures().push(f);
    this.atualizarCartao();
  }

  @HostListener('document:keydown.escape')
  protected cancelarDesenho(): void {
    this.draw?.abortDrawing();
    this.encerrarDesenho();
  }

  protected desfazerPonto(): void {
    if (this.modo() === 'piquete') this.draw?.removeLastPoint();
  }

  @HostListener('document:keydown.backspace', ['$event'])
  protected backspace(evt: Event): void {
    const alvo = evt.target as HTMLElement | null;
    if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA' || alvo.tagName === 'SELECT')) return;
    this.desfazerPonto();
  }

  private encerrarDesenho(): void {
    if (this.draw) this.map?.removeInteraction(this.draw);
    if (this.snapDesenho) this.map?.removeInteraction(this.snapDesenho);
    this.draw = undefined;
    this.snapDesenho = undefined;
    this.modo.set('parado');
    this.select?.setActive(true);
    this.modify?.setActive(true);
  }

  // ---------- "Terminei" ----------

  protected terminei(): void {
    this.cancelarDesenho();
    this.limparSelecao();
    const atuais = this.fonte.getFeatures().filter((f) => f.get('feature_type') !== 'rural_property');
    const ids = new Set(atuais.map((f) => String(f.getId() ?? '')));
    const novos: string[] = [];
    const alterados: string[] = [];
    const alfinetes: string[] = [];
    for (const f of atuais) {
      const antes = this.inicial.get(String(f.getId() ?? ''));
      if (f.get('feature_type') === 'pin') {
        if (!antes) alfinetes.push(rotulo(f));
        continue;
      }
      if (!antes) novos.push(rotulo(f));
      else if (antes.geom !== this.geomTexto(f) || antes.rotulo !== rotulo(f)) alterados.push(rotulo(f));
    }
    const apagados = [...this.inicial.entries()].filter(([id]) => !ids.has(id)).map(([, v]) => v.rotulo);

    const saida = {
      type: 'FeatureCollection',
      features: this.fonte.getFeatures().map((f) => {
        const obj = this.fmt.writeFeatureObject(f, { decimals: 7 });
        const tipo = f.get('feature_type');
        obj.properties = {
          feature_type: tipo,
          ...(tipo === 'paddock' ? { display_number: f.get('display_number') } : {}),
          ...(tipo === 'pin' ? { pin_type: f.get('pin_type') } : {}),
          name: tipo === 'rural_property' ? f.get('feature_id') : rotulo(f),
          ...(tipo !== 'pin' ? { area_ha: Number(areaHa(this.poly(f)).toFixed(4)) } : {}),
          origem: this.inicial.has(String(f.getId() ?? '')) ? 'chat' : 'mapa',
        };
        return obj;
      }),
    };
    this.resumo.set({ novos, alterados, apagados, alfinetes, geojson: JSON.stringify(saida, null, 2) });
  }

  protected fecharResumo(): void {
    this.resumo.set(null);
  }

  protected async copiarGeojson(): Promise<void> {
    const r = this.resumo();
    if (!r) return;
    await navigator.clipboard.writeText(r.geojson);
    this.mostrarNota('GeoJSON copiado.');
  }

  protected baixarGeojson(): void {
    const r = this.resumo();
    if (!r) return;
    const url = URL.createObjectURL(new Blob([r.geojson], { type: 'application/geo+json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fazenda-editada.geojson';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- mensagens ----------

  private mostrarNota(texto: string): void {
    this.nota.set(texto);
    clearTimeout(this.notaTimer);
    this.notaTimer = setTimeout(() => this.nota.set(null), 5000);
  }
}
