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
import DoubleClickZoom from 'ol/interaction/DoubleClickZoom';
import { simplify } from '@turf/turf';
import { click } from 'ol/events/condition';
import type { Feature as GjFeature, Geometry as GjGeometry, Point as GjPoint } from 'geojson';
import { environment } from '../../environments/environment';
import {
  LASCA_M2,
  Poligono,
  aplicarCerca,
  areaHa,
  consertar,
  partes,
  pontoDentro,
  resolverSobreposicao,
  uniao,
} from './regras';
import { AlfineteApi, ErroApi, LinkApi, PiqueteApi, api, tokenDaUrl } from './api';

// IDs do satélite no MapTiler, do mais novo para o mais antigo; usa o primeiro que existir.
const SATELITE_IDS = ['satellite-v2', 'satellite-v4', 'satellite'];
// Fazenda de teste exportada do Pasto Legal (dev) — ver webgis/scripts/exportar_fazenda.py.
// Só é usada no modo demonstração (sem #t= na URL), como na demo do GitHub Pages.
const FAZENDA_URL = 'fazenda-teste.geojson';
/** Espera depois da última edição antes de salvar (salvar automático). */
const ESPERA_SALVAR_MS = 1000;
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

type EstadoSalvar = 'salvo' | 'salvando' | 'pendente' | 'erro' | 'offline';

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

  /** Como a fazenda chegou do chat, para montar o resumo do "Terminei". */
  private inicial = new Map<string, { rotulo: string; geom: string }>();

  protected readonly fazenda = signal<{ nome: string; areaHa: string } | null>(null);
  protected readonly aviso = signal<string | null>(null);
  protected readonly nota = signal<string | null>(null);
  protected readonly modo = signal<'parado' | 'piquete' | 'alfinete'>('parado');
  protected readonly selecionado = signal<InfoSelecionado | null>(null);
  protected readonly resumo = signal<Resumo | null>(null);
  private notaTimer?: ReturnType<typeof setTimeout>;

  /** Tela de toque (celular/tablet): desenho "segura e arrasta" e alvos maiores. */
  protected readonly toque = window.matchMedia('(pointer: coarse)').matches;

  /** Token do link (#t=...). Sem token = modo demonstração, sem API. */
  private readonly token = tokenDaUrl();
  protected readonly comApi = this.token !== null;
  /** Versão do rascunho no servidor; cada salvamento soma 1. */
  private versao = 0;
  private salvarTimer?: ReturnType<typeof setTimeout>;
  /** true enquanto aplicamos no mapa a geometria corrigida pelo servidor (não dispara novo salvar). */
  private aplicandoServidor = false;
  protected readonly salvar = signal<EstadoSalvar>('salvo');
  /** Mapa só leitura: link terminado, expirado ou substituído. */
  protected readonly somenteLeitura = signal<string | null>(null);
  protected readonly enviado = signal(false);

  ngAfterViewInit(): void {
    this.map = new OlMap({
      target: this.mapEl.nativeElement,
      layers: [new VectorLayer({ source: this.fonte, style: estiloFeicao, zIndex: 10 })],
      view: new View({ center: fromLonLat([-49.25, -16.68]), zoom: 14 }),
    });
    // Colar outro link na mesma aba só muda o "#": o navegador não recarrega sozinho.
    window.addEventListener('hashchange', () => window.location.reload());
    this.carregarSatelite();
    this.ativarEdicao();
    if (this.token) this.carregarDaApi(this.token);
    else this.carregarFazenda();
  }

  ngOnDestroy(): void {
    clearTimeout(this.notaTimer);
    clearTimeout(this.salvarTimer);
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

  // ---------- API: abrir o link e salvar automático ----------

  private async carregarDaApi(token: string): Promise<void> {
    let link: LinkApi;
    try {
      link = await api.abrir(token);
    } catch (e) {
      this.travar(e instanceof ErroApi ? e.message : String(e));
      return;
    }
    this.versao = link.version;

    const cerca = new Feature<Geometry>(this.lerGeom(link.farm.geometry));
    cerca.setProperties({ feature_type: 'rural_property', feature_id: link.farm.id, name: link.farm.name });
    const features: Feature<Geometry>[] = [cerca];
    for (const p of link.paddocks) {
      const f = new Feature<Geometry>(this.lerGeom(p.geometry));
      f.setProperties({ feature_type: 'paddock', display_number: p.number, name: p.name ?? undefined });
      if (p.id) f.setId(p.id);
      features.push(f);
    }
    for (const a of link.pins) {
      const f = new Feature<Geometry>(this.lerGeom({ type: 'Point', coordinates: [a.lon, a.lat] }));
      f.setProperties({ feature_type: 'pin', pin_type: a.kind, name: a.name ?? undefined });
      if (a.id) f.setId(a.id);
      features.push(f);
    }
    this.fonte.addFeatures(features);
    for (const f of features) {
      if (f.get('feature_type') === 'rural_property' || f.getId() === undefined) continue;
      this.inicial.set(String(f.getId()), { rotulo: rotulo(f), geom: this.geomTexto(f) });
    }
    this.fazenda.set({
      nome: nomeFazenda(cerca),
      areaHa: areaHa(this.poly(cerca)).toLocaleString('pt-BR', { maximumFractionDigits: 0 }),
    });
    const extent = this.fonte.getExtent();
    if (extent) this.map?.getView().fit(extent, { padding: [60, 60, 120, 60], maxZoom: 18 });

    if (link.read_only) {
      this.travar(link.message ?? 'Este mapa está só para leitura.');
      return;
    }
    // A partir daqui, toda mudança no mapa agenda um salvamento.
    this.fonte.on(['addfeature', 'removefeature', 'changefeature'], () => this.agendarSalvar());
    window.addEventListener('offline', () => this.salvar.set('offline'));
    window.addEventListener('online', () => this.agendarSalvar());
  }

  private agendarSalvar(): void {
    if (!this.token || this.aplicandoServidor || this.somenteLeitura()) return;
    this.salvar.set(navigator.onLine ? 'pendente' : 'offline');
    clearTimeout(this.salvarTimer);
    this.salvarTimer = setTimeout(() => this.salvarAgora(), ESPERA_SALVAR_MS);
  }

  /** Piquetes e alfinetes do mapa no formato da API. */
  private conteudo(): { paddocks: PiqueteApi[]; pins: AlfineteApi[] } {
    const paddocks: PiqueteApi[] = [];
    const pins: AlfineteApi[] = [];
    for (const f of this.fonte.getFeatures()) {
      const tipo = f.get('feature_type');
      const id = f.getId() === undefined ? null : String(f.getId());
      const g = f.getGeometry();
      if (!g) continue;
      const geometry = this.fmt.writeGeometryObject(g, { decimals: 7 });
      if (tipo === 'paddock') {
        paddocks.push({ id, number: f.get('display_number'), name: f.get('name') ?? null, geometry });
      } else if (tipo === 'pin' && geometry.type === 'Point') {
        const [lon, lat] = geometry.coordinates;
        pins.push({ id, kind: f.get('pin_type') ?? 'bebedouro', name: f.get('name') ?? null, lon, lat });
      }
    }
    return { paddocks, pins };
  }

  private async salvarAgora(): Promise<boolean> {
    if (!this.token || this.somenteLeitura()) return false;
    if (!navigator.onLine) {
      this.salvar.set('offline');
      return false;
    }
    clearTimeout(this.salvarTimer);
    this.salvar.set('salvando');
    try {
      const r = await api.salvar(this.token, { version: this.versao, ...this.conteudo() });
      this.versao = r.version;
      this.aplicarCorrecoes(r.paddocks);
      this.salvar.set('salvo');
      return true;
    } catch (e) {
      const erro = e instanceof ErroApi ? e : new ErroApi(0, String(e));
      if (erro.status === 409 || erro.status === 410 || erro.status === 404) this.travar(erro.message);
      else {
        this.salvar.set(erro.status === 0 ? 'offline' : 'erro');
        this.mostrarNota(erro.message);
      }
      return false;
    }
  }

  /** O servidor manda: se ele corrigiu um piquete (ex.: cortou na cerca), o mapa redesenha. */
  private aplicarCorrecoes(paddocks: PiqueteApi[]): void {
    const porNumero = new Map(paddocks.map((p) => [p.number, p]));
    this.aplicandoServidor = true;
    try {
      for (const f of this.piquetes()) {
        const p = porNumero.get(f.get('display_number'));
        const g = f.getGeometry();
        if (!p || !g) continue;
        const nova = this.fmt.writeGeometry(this.lerGeom(p.geometry), { decimals: 7 });
        if (nova !== this.fmt.writeGeometry(g, { decimals: 7 })) f.setGeometry(this.lerGeom(p.geometry));
      }
    } finally {
      this.aplicandoServidor = false;
    }
  }

  /** Para tudo e deixa o mapa só para leitura, com a mensagem na tela. */
  private travar(mensagem: string): void {
    clearTimeout(this.salvarTimer);
    this.cancelarDesenho();
    this.limparSelecao();
    this.select?.setActive(false);
    this.modify?.setActive(false);
    this.somenteLeitura.set(mensagem);
  }

  /** Aviso do navegador ao sair com alteração ainda não salva. */
  @HostListener('window:beforeunload', ['$event'])
  protected antesDeSair(evt: BeforeUnloadEvent): void {
    const s = this.salvar();
    if (this.comApi && !this.somenteLeitura() && (s === 'pendente' || s === 'salvando' || s === 'offline' || s === 'erro')) {
      evt.preventDefault();
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
      } else {
        if (id) f.set('name', id);
        semNumero.push(f);
      }
    }
    let maior = Math.max(0, ...features.map((f) => Number(f.get('display_number')) || 0));
    for (const f of semNumero) f.set('display_number', ++maior);
  }

  /**
   * Próximo número = maior número existente + 1 (decisão de 19/11): buracos não são
   * preenchidos (1,2,3,4 apaga 3 → 5); se apagar o último, ele volta (1,2,3 apaga 3 → 3).
   */
  private proximoNumero(): number {
    const numeros = this.piquetes().map((f) => Number(f.get('display_number')) || 0);
    return Math.max(0, ...numeros) + 1;
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

  private lerGeom(g: GjGeometry): Geometry {
    const geo = this.fmt.readGeometry(g);
    if (!geo) throw new Error('Geometria inválida');
    return geo;
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
        const cortou = areaHa(r.geom) < areaHa(consertar(this.poly(f))) - 1e-6;
        f.setGeometry(this.geom(r.geom));
        if (cortou) mensagens.push('Uma parte passou da cerca e voltou para o limite.');
      }
    }

    // Sobreposição (regras.resolverSobreposicao): o que já existia manda; o desenho novo
    // fica com o que sobra. Desenho inteiro dentro de um piquete = dividir esse piquete.
    let atual: Poligono | null = this.poly(f);
    const encostou: string[] = [];
    let dividiu = false;
    for (const vizinho of this.piquetes(f)) {
      if (!atual) break;
      const r = resolverSobreposicao(atual, this.poly(vizinho));
      if (r.tipo === 'nada') continue;
      vizinho.setGeometry(this.geom(r.vizinho));
      r.novos.forEach((p) => this.novoPiquete(p));
      if (r.tipo === 'antigo') encostou.push(rotulo(vizinho));
      else dividiu = true;
      atual = r.novo;
    }

    if (!atual) {
      this.fonte.removeFeature(f); // o desenho virou só partes em comum
    } else if (encostou.length || dividiu) {
      if (areaHa(atual) * 10_000 < LASCA_M2) {
        this.fonte.removeFeature(f); // só sobrou uma lasca: não vira piquete
        this.mostrarNota(`Esse espaço já é do ${encostou.join(', ')}.`);
        return true;
      }
      // Pedaços soltos grandes viram piquetes; lascas ficam junto do desenho.
      const [maior, ...extras] = partes(atual);
      let g = maior;
      for (const p of extras) {
        if (areaHa(p) * 10_000 < LASCA_M2) g = uniao(g, p);
        else this.novoPiquete(p);
      }
      f.setGeometry(this.geom(g));
    }
    if (encostou.length) mensagens.push(`A parte por cima do ${encostou.join(', ')} continuou dele.`);
    if (dividiu) mensagens.push('Desenho dentro de um piquete: ele foi dividido.');
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
      hitTolerance: this.toque ? 14 : 5,
    });
    this.select.on('select', () => this.atualizarCartao());

    // Editar: arrastar vértices do piquete (ou mover o alfinete) selecionado.
    this.modify = new Modify({ features: this.select.getFeatures(), pixelTolerance: this.toque ? 22 : 10 });
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
    this.agendarSalvar();
  }

  protected mudarTipoAlfinete(valor: string): void {
    const f = this.selecionadoAtual();
    if (!f) return;
    f.set('pin_type', valor === 'outro' ? 'outro' : 'bebedouro');
    this.atualizarCartao();
    this.agendarSalvar();
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
    if (!this.map || this.modo() !== 'parado' || this.somenteLeitura()) return;
    this.limparSelecao();
    this.select?.setActive(false);
    this.modify?.setActive(false);

    // No toque: "segura e arrasta" (mão livre) — encosta o dedo, contorna o pasto e solta.
    // No mouse: clica nos cantos. Durante o desenho, toque duplo não dá zoom.
    this.draw = new Draw({ type: tipo === 'piquete' ? 'Polygon' : 'Point', freehand: tipo === 'piquete' && this.toque });
    this.zoomDuploToque(false);
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
    if (this.toque) {
      // Traço de dedo tem centenas de pontos tremidos: suaviza (~2 m) antes das regras.
      const suave = simplify(this.poly(f), { tolerance: 0.00002, highQuality: true });
      f.setGeometry(this.geom(suave));
    }
    f.set('feature_type', 'paddock');
    f.set('display_number', this.proximoNumero());
    this.fonte.addFeature(f);
    if (!this.aplicarRegras(f)) {
      this.fonte.removeFeature(f); // recusado: o número volta a ficar livre
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

  /** Liga/desliga o zoom do toque duplo (atrapalha fechar o piquete no celular). */
  private zoomDuploToque(ativo: boolean): void {
    this.map?.getInteractions().forEach((i) => {
      if (i instanceof DoubleClickZoom) i.setActive(ativo);
    });
  }

  /** Botão "✓ Fechar piquete" (desenho por cantos). */
  protected fecharPiquete(): void {
    if (this.modo() === 'piquete') this.draw?.finishDrawing();
  }

  protected recarregar(): void {
    window.location.reload();
  }

  private encerrarDesenho(): void {
    // Religa o zoom do toque duplo depois que o OpenLayers terminar o evento do desenho.
    setTimeout(() => this.zoomDuploToque(true), 300);
    if (this.draw) this.map?.removeInteraction(this.draw);
    if (this.snapDesenho) this.map?.removeInteraction(this.snapDesenho);
    this.draw = undefined;
    this.snapDesenho = undefined;
    this.modo.set('parado');
    this.select?.setActive(true);
    this.modify?.setActive(true);
  }

  // ---------- "Terminei" ----------

  protected async terminei(): Promise<void> {
    if (this.token) {
      await this.terminarNaApi(this.token);
      return;
    }
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

  /** "Terminei" com link: salva o que faltar, avisa a API e trava o mapa. */
  private async terminarNaApi(token: string): Promise<void> {
    this.cancelarDesenho();
    this.limparSelecao();
    if (this.salvar() !== 'salvo' && !(await this.salvarAgora())) {
      this.mostrarNota('Não consegui salvar as últimas alterações. Confira a internet e tente de novo.');
      return;
    }
    try {
      const r = await api.terminar(token);
      this.enviado.set(true);
      this.travar(
        r.notified
          ? 'Pronto! Suas alterações foram enviadas. Confira no WhatsApp para confirmar.'
          : 'Pronto! Volte ao WhatsApp e mande um oi para confirmar as alterações.',
      );
    } catch (e) {
      this.mostrarNota(e instanceof ErroApi ? e.message : String(e));
    }
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
