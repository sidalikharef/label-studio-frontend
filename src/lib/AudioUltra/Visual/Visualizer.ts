import { ChannelData } from '../Media/ChannelData';
import { WaveformAudio } from '../Media/WaveformAudio';
import { averageMinMax, clamp, debounce, defaults, filterData, measure, roundToStep, warn } from '../Common/Utils';
import { Waveform, WaveformOptions } from '../Waveform';
import { CanvasCompositeOperation, Layer, RenderingContext } from './Layer';
import { Events } from '../Common/Events';
import { LayerGroup } from './LayerGroup';
import { Playhead } from './PlayHead';
import { rgba } from '../Common/Color';
import { Cursor } from '../Cursor/Cursor';
import { Padding } from '../Common/Style';
import { TimelineOptions } from '../Timeline/Timeline';
import './Loader';

interface VisualizerEvents {
  draw: (visualizer: Visualizer) => void;
  initialized: (visualizer: Visualizer) => void;
  destroy: (visualizer: Visualizer) => void;
  mouseMove: (event: MouseEvent, cursor: Cursor) => void;
  layersUpdated: (layers: Map<string, Layer>) => void;
  layerAdded: (layer: Layer) => void;
  layerRemoved: (layer: Layer) => void;
  heightAdjusted: (Visualizer: Visualizer) => void;
}

export type VisualizerOptions = Pick<WaveformOptions,
| 'zoomToCursor'
| 'autoCenter'
| 'splitChannels'
| 'enabledChannels'
| 'cursorWidth'
| 'zoom'
| 'amp'
| 'padding'
| 'playhead'
| 'timeline'
| 'height'
| 'gridWidth'
| 'gridColor'
| 'waveColor'
| 'backgroundColor'
| 'container'
> 

export class Visualizer extends Events<VisualizerEvents> {
  private wrapper!: HTMLElement;
  private layers = new Map<string, Layer>();
  private observer!: ResizeObserver;
  private currentTime = 0;
  private audio!: WaveformAudio | null;
  private zoom = 1;
  private scrollLeft = 0;
  private drawing = false;
  private amp = 1;
  private seekLocked = false;
  private wf: Waveform;
  private waveContainer!: HTMLElement | string;
  private channels: ChannelData[] = [];
  private playheadPadding = 4;
  private zoomToCursor = false;
  private autoCenter = false;
  private splitChannels = false;
  private enabledChannels = [0];
  private padding: Padding = { top: 0, bottom: 0, left: 0, right: 0 };
  private gridWidth = 1;
  private gridColor = rgba('rgba(0, 0, 0, 0.1)');
  private backgroundColor = rgba('#fff');
  private waveColor = rgba('#000');
  private waveHeight = 100;
  private _container!: HTMLElement;
  private _loader!: HTMLElement;

  timelineHeight: number = defaults.timelineHeight;
  timelinePlacement: TimelineOptions['placement'] = 'top';
  maxZoom = 1500;
  playhead: Playhead;
  reservedSpace = 0;
  samplesPerPx = 0;

  constructor(options: VisualizerOptions, waveform: Waveform) {
    super();

    this.wf = waveform;
    this.waveContainer = options.container;
    this.waveHeight = options.height ?? this.waveHeight;
    this.waveColor = options.waveColor ? rgba(options.waveColor) : this.waveColor;
    this.padding = { ...this.padding, ...options.padding };
    this.playheadPadding = options.playhead?.padding ?? this.playheadPadding;
    this.zoomToCursor = options.zoomToCursor ?? this.zoomToCursor;
    this.autoCenter = options.autoCenter ?? this.autoCenter;
    this.splitChannels = options.splitChannels ?? this.splitChannels;
    this.enabledChannels = options.enabledChannels ?? this.enabledChannels;
    this.timelineHeight = options.timeline?.height ?? this.timelineHeight;
    this.timelinePlacement = options?.timeline?.placement ?? this.timelinePlacement;
    this.gridColor = options.gridColor ? rgba(options.gridColor) : this.gridColor;
    this.gridWidth = options.gridWidth ?? this.gridWidth;
    this.backgroundColor = options.backgroundColor ? rgba(options.backgroundColor) : this.backgroundColor;
    this.zoom = options.zoom ?? this.zoom;
    this.amp = options.amp ?? this.amp;
    this.playhead = new Playhead({ 
      ...options.playhead,
      x: 0, 
      color: rgba('#000'), 
      fillColor: rgba('#BAE7FF'),
      width: options.cursorWidth ?? 1,
    }, this, this.wf);

    this.initialRender();
    this.attachEvents();
  }

  init(audio: WaveformAudio) {
    this.init = () => warn('Visualizer is already initialized');
    this.audio = audio;
    this.channels.length = this.audio.channelCount;

    this.enabledChannels.forEach((channelNumber: number) => {
      const data = filterData(audio.buffer, channelNumber);

      this.getSamplesPerPx();

      this.channels[channelNumber] = new ChannelData({
        data,
        visualizer: this,
        waveform: this.wf,
        getChunksSize: () => {
          return this.samplesPerPx;
        },
      });
    });

    this.updateChannels(() => {
      this.setLoading(false);
      this.invoke('initialized', [this]);
      this.draw();
    });
  }

  setLoading(loading: boolean) {
    if (loading) {
      this._loader = document.createElement('loading-progress-bar');
      this._container.appendChild(this._loader);
    } else {
      this._container.removeChild(this._loader);
    }
  }

  setLoadingProgress(loaded?: number, total?: number, completed?: boolean) {
    if (this._loader) {
      if (completed) {
        (this._loader as any).total = (this._loader as any).loaded;
      } else {
        if (loaded !== undefined) (this._loader as any).loaded = loaded;
        if (total !== undefined) (this._loader as any).total = total;
      }
      (this._loader as any).update();
    }
  }

  async updateChannels(callback?: () => void) {
    for(const channel of this.channels) {
      if (!channel) continue;
      await channel.recalculate();
    }

    if (callback instanceof Function) {
      callback();
    }
  }

  setZoom(value: number) {
    this.zoom = clamp(value, 1, this.maxZoom);
    if (this.zoomToCursor) {
      this.centerToCurrentTime();
    } else {
      this.updatePosition(false);
    }

    this.getSamplesPerPx();

    this.updateChannels(() => {
      this.wf.invoke('zoom', [this.zoom]);
      this.draw();
    });
  }

  getZoom() {
    return this.zoom;
  }

  setScrollLeft(value: number, redraw = true, forceDraw = false) {
    this.scrollLeft = value;

    if (redraw) {
      this.draw(false, forceDraw);
    }
  }

  getScrollLeft() {
    return this.scrollLeft;
  }

  getScrollLeftPx() {
    return this.scrollLeft * this.fullWidth;
  }

  lockSeek() {
    this.seekLocked = true;
  }

  unlockSeek() {
    this.seekLocked = false;
  }

  draw(dry = false, forceDraw = false) {
    if (this.isDestroyed) return;
    if (this.drawing && !forceDraw) return warn('Concurrent render detected');

    this.drawing = true;

    setTimeout(() => {
      if (!dry) {
        this.drawMiddleLine();

        if (this.wf.playing && this.autoCenter) {
          this.centerToCurrentTime();
        }

        // Render all enabled channels
        this.renderAvailableChannels();
      }

      this.renderCursor();

      this.invoke('draw', [this]);

      this.transferImage();

      this.drawing = false;
    });
  }

  destroy() {
    if (this.isDestroyed) return;

    this.channels.forEach(channel => {
      if (channel) {
        channel.destroy();
      }
    });
    this.invoke('destroy', [this]);
    this.clear();
    this.playhead.destroy();
    this.audio = null;
    this.removeEvents();
    this.layers.forEach(layer => layer.remove());
    this.wrapper.remove();

    super.destroy();
  }

  clear() {
    this.layers.get('main')?.clear();
    this.transferImage();
  }

  getAmp() {
    return this.amp;
  }

  setAmp(amp: number) {
    this.amp = clamp(amp, 1, Infinity);
    this.draw();
  }

  getChannelData(index: number) {
    return this.channels[index].data;
  }

  centerToCurrentTime() {
    if (this.zoom === 1) {
      this.scrollLeft = 0;
      return;
    }

    const offset = (this.width / 2) / this.zoomedWidth;

    this.scrollLeft = clamp(this.currentTime - offset, 0, 1);
  }

  /**
   * Update the visual render of the cursor in isolation
   */
  updateCursorToTime(time: number) {
    this.playhead.updatePositionFromTime(time);
  }

  private renderAvailableChannels() {
    if (!this.audio) return;

    this.useLayer('waveform', (layer) => {
      layer.clear();
      this.enabledChannels.forEach((channel) => {
        measure(`Render wave channel ${channel}`, () => {
          this.renderWave(channel, layer);
        });
      });
    });
  }

  private renderWave(channelNumber: number, layer: Layer) {
    const channel = this.channels[channelNumber];
   
    if (!channel || channel.isDestroyed) return;

    const fullHeight = this.height;
    const paddingTop = this.padding?.top ?? 0;
    const paddingLeft = this.padding?.left ?? 0;
    const waveHeight = fullHeight - this.reservedSpace;
    const zero = fullHeight * (this.splitChannels ? channelNumber : 0) + (defaults.timelinePlacement as number ? this.reservedSpace : 0);
    const height = waveHeight / (this.splitChannels ? this.audio?.channelCount ?? 1 : 1);

    const dataLength = channel.data.length;
    const scrollLeftPx = this.getScrollLeftPx();

    const iStart = clamp(
      roundToStep(
        scrollLeftPx * this.samplesPerPx,
        this.samplesPerPx,
        'floor',
      ), 0, dataLength);

    const iEnd = clamp(
      roundToStep(
        iStart + (this.width * this.samplesPerPx),
        this.samplesPerPx,
        'ceil',
      ), 0, dataLength);

    const x = 0;
    const y = zero + paddingTop + height / 2;

    if (this.isDestroyed || channel.isDestroyed) return;

    const renderable = channel.data.slice(iStart, iEnd);

    this.renderAllChunks(
      layer,
      renderable,
      x,
      y,
      height,
      paddingLeft,
      zero,
    );
  }

  private renderAllChunks(
    layer: Layer,
    chunks: Float32Array,
    x: number,
    y: number,
    height: number,
    paddingLeft: number,
    zero: number,
  ) {
    layer.save();

    const waveColor = this.waveColor.toString();

    layer.strokeStyle = waveColor;
    layer.fillStyle = waveColor;
    layer.lineWidth = 1;

    layer.beginPath();
    layer.moveTo(x, y);

    const l = chunks.length - 1;
    let i = l + 1;

    while (i > 0) {
      const index = l - i;
      const chunk = chunks.slice(index, index + this.samplesPerPx);

      if (x >= 0 && chunk.length > 0) {
        this.renderChunk(chunk, layer, height, x + paddingLeft, zero);
      }

      x += 1;
      i = clamp(i - this.samplesPerPx, 0, l);
    }

    layer.stroke();
    layer.restore();
  }

  private renderChunk(chunk: Float32Array, layer: Layer, height: number, offset: number, zero: number) {
    layer.save();

    const renderable = averageMinMax(chunk);

    renderable.forEach((v) => {
      const H2 = height / 2;
      const H = (v * this.amp * H2);

      layer.lineTo(offset + 1, zero + H2 + H);
    });
    layer.restore();
  }

  private renderCursor() {
    this.playhead.render();
  }

  private drawMiddleLine() {
    this.useLayer('background', (layer) => {
      layer.clear();
      if (layer.isVisible) {
        // Set background
        layer.save();
        layer.fillStyle = this.backgroundColor.toString();
        layer.fillRect(0, 0, this.width, this.height);
        layer.restore();

        // Draw middle line
        layer.lineWidth = this.gridWidth;
        layer.strokeStyle = this.gridColor.toString();

        // Draw middle line
        const linePositionY = (this.height + this.reservedSpace) / 2;

        layer.beginPath();
        layer.moveTo(0, linePositionY);
        layer.lineTo(this.width, linePositionY);
        layer.closePath();
        layer.stroke();
        layer.restore();
      }
    });
  }

  get pixelRatio() {
    return window.devicePixelRatio;
  }

  get width() {
    return this.container.clientWidth;
  }

  get height() {
    let height = 0;
    const timelineLayer = this.getLayer('timeline');
    const waveformLayer = this.getLayer('waveform');

    height += timelineLayer?.isVisible ? this.timelineHeight : 0;
    height += waveformLayer?.isVisible ? (this?.wf?.params?.height ?? 0) - this.timelineHeight : 0;
    return height;
  }

  get scrollWidth() {
    return this.zoomedWidth - this.width;
  }

  get fullWidth() {
    return this.zoomedWidth;
  }

  get zoomedWidth() {
    return this.width * this.zoom;
  }

  get container(){
    if (this._container) return this._container;

    let result: HTMLElement | null = null;

    if (this.waveContainer instanceof HTMLElement) {
      result = this.waveContainer;
    } else if (typeof this.waveContainer === 'string') {
      result = document.querySelector(this.waveContainer as string);
    }

    if (!result) throw new Error('Container element does not exist.');

    result.style.position = 'relative';

    this._container = result;

    return result;
  }

  private initialRender() {
    if (this.container) {
      this.container.style.height = `${this.waveHeight}px`;
      this.createLayers();
    } else {
      // TBD
    }

    this.drawMiddleLine();
    this.transferImage();
  }

  private createLayers() {
    const { container } = this;

    this.wrapper = document.createElement('div');
    this.wrapper.style.height = '100%';

    this.createLayer({ name: 'main' });
    this.createLayer({ name: 'background', offscreen: true, zIndex: 0, isVisible: false });
    this.createLayer({ name: 'waveform', offscreen: true, zIndex: 100 });
    this.createLayerGroup({ name: 'regions', offscreen: true, zIndex: 101, compositeOperation: 'source-over' });
    const controlsLayer = this.createLayer({ name: 'controls', offscreen: true, zIndex: 1000 });

    this.playhead.setLayer(controlsLayer);
    this.layers.get('main')?.appendTo(this.wrapper);
    container.appendChild(this.wrapper);
  }

  reserveSpace({ height }: { height: number }) {
    this.reservedSpace = height;
  }

  createLayer(options : {name: string, groupName?:string, offscreen?: boolean, zIndex?: number, opacity?: number, compositeOperation?: CanvasCompositeOperation, isVisible?: boolean}) {
    const { name, offscreen = false, zIndex = 1, opacity = 1, compositeOperation = 'source-over', isVisible } = options;

    if (!options.groupName && this.layers.has(name)) throw new Error(`Layer ${name} already exists.`);

    const layerOptions = {
      groupName: options.groupName,
      name,
      container: this.container,
      height: this.waveHeight,
      pixelRatio: this.pixelRatio,
      index: zIndex,
      offscreen,
      compositeOperation,
      opacity,
      isVisible,
    };

    let layer: Layer;

    if (options.groupName) {
      const group = this.layers.get(options.groupName);

      if (!group || !group.isGroup) throw new Error(`LayerGroup ${options.groupName} does not exist.`);

      layer = (group as LayerGroup).addLayer(layerOptions);
    } else {

      layer = new Layer(layerOptions);
      this.layers.set(name, layer);
    }

    this.invoke('layerAdded', [layer]);
    layer.on('layerUpdated', () => {
      const mainLayer = this.getLayer('main');

      this.container.style.height = `${this.height}px`;
      if (mainLayer) {
        mainLayer.height = this.height;
      }
      this.draw();
      this.invokeLayersUpdated();
    });

    return layer;
  }

  createLayerGroup(options : {name: string, offscreen?: boolean, zIndex?: number, opacity?: number, compositeAsGroup?: boolean, compositeOperation?: CanvasCompositeOperation}) {
    const { name, offscreen = false, zIndex = 1, opacity = 1, compositeOperation = 'source-over', compositeAsGroup = true } = options;

    if (this.layers.has(name)) throw new Error(`LayerGroup ${name} already exists.`);

    const layer = new LayerGroup({
      name,
      container: this.container,
      height: this.waveHeight,
      pixelRatio: this.pixelRatio,
      index: zIndex,
      offscreen,
      compositeOperation,
      compositeAsGroup,
      opacity,
    });

    this.invoke('layerAdded', [layer]);
    layer.on('layerUpdated', () => {
      this.draw();
      this.invokeLayersUpdated();
    });
    this.layers.set(name, layer);
    return layer;
  }

  removeLayer(name: string) {
    if (!this.layers.has(name)) throw new Error(`Layer ${name} does not exist.`);
    const layer = this.layers.get(name);

    if(layer) {
      this.invoke('layerRemoved', [layer]);
      layer.off('layerUpdated', this.invokeLayersUpdated);
      layer.remove();
    }
    this.layers.delete(name);
  }

  getLayer(name: string) {
    return this.layers.get(name);
  }

  getLayers() {
    return this.layers;
  }

  useLayer(name: string, callback: (layer: Layer, context: RenderingContext) => void) {
    const layer = this.layers.get(name)!;

    if (layer) {
      callback(layer, layer.context!);
    }
  }

  private invokeLayersUpdated = debounce(() => {
    this.invoke('layersUpdated', [this.layers]);
  }, 150);

  private attachEvents() {
    // Observers
    this.observer = new ResizeObserver(this.handleResize);
    this.observer.observe(this.wrapper);

    // DOM events
    this.wrapper.addEventListener('wheel', this.preventScrollX);
    this.wrapper.addEventListener('wheel', this.handleScroll, {
      passive: true,
    });
    this.wrapper.addEventListener('click', this.handleSeek);
    this.wrapper.addEventListener('mousedown', this.handleMouseDown);

    // Cursor events
    this.on('mouseMove', this.playHeadMove);

    this.on('layerAdded', this.invokeLayersUpdated);
    this.on('layerRemoved', this.invokeLayersUpdated);

    // WF events
    this.wf.on('playing', this.handlePlaying);
    this.wf.on('seek', this.handlePlaying);
  }

  private removeEvents() {
    // Observers
    this.observer.unobserve(this.wrapper);
    this.observer.disconnect();

    // DOM events
    this.wrapper.removeEventListener('wheel', this.preventScrollX);
    this.wrapper.removeEventListener('wheel', this.handleScroll);
    this.wrapper.removeEventListener('click', this.handleSeek);
    this.wrapper.removeEventListener('mousedown', this.handleMouseDown);

    // Cursor events
    this.off('mouseMove', this.playHeadMove);

    this.off('layerAdded', this.invokeLayersUpdated);
    this.off('layerRemoved', this.invokeLayersUpdated);

    // WF events
    this.wf.off('playing', this.handlePlaying);
    this.wf.off('seek', this.handlePlaying);
  }

  private playHeadMove = (e: MouseEvent, cursor: Cursor) => {
    if (!this.wf.loaded) return;
    if (e.target && this.container.contains(e.target)) {
      const { x, y } = cursor;
      const { playhead, playheadPadding, height } = this;
      const playHeadTop = (this.reservedSpace - playhead.capHeight - playhead.capPadding);

      if (x >= playhead.x - playheadPadding && 
        x <= (playhead.x + playhead.width + playheadPadding) &&
          y >= playHeadTop &&
          y <= height) {
        if(!playhead.isHovered) {
          playhead.invoke('mouseEnter', [e]);
        }
        this.draw(true);
      } else if (playhead.isHovered) {
        playhead.invoke('mouseLeave', [e]);
        this.draw(true);
      }
    }
  };

  private handleSeek = (e: MouseEvent) => {
    const mainLayer = this.getLayer('main');

    if (!this.wf.loaded || this.seekLocked || !(e.target && mainLayer?.canvas?.contains(e.target))) return;
    const offset = this.wrapper.getBoundingClientRect().left;
    const x = e.clientX - offset;
    const duration = this.wf.duration;
    const currentPosition = this.scrollLeft + ((x / this.container.clientWidth) / this.zoom);
    const playheadX = clamp(x, 0, this.width);

    this.playhead.setX(playheadX);
    this.wf.currentTime = currentPosition * duration;
  };

  private handleMouseDown = (e: MouseEvent) => {
    if (!this.wf.loaded) return;
    this.playhead.invoke('mouseDown', [e]);
  };

  private handlePlaying = (currentTime: number) => {
    if (!this.wf.loaded) return;
    this.currentTime = currentTime / this.wf.duration;
    this.draw(this.zoom === 1);
  };

  private handleScroll = (e: WheelEvent) => {
    if (!this.wf.loaded) return;

    if (this.isZooming(e)) {
      const zoom = this.zoom - (e.deltaY * 0.2);

      this.setZoom(zoom);
      this.wf.invoke('zoom', [this.zoom]);
    } else if (this.zoom > 1) {
      // Base values
      const maxScroll = this.scrollWidth;
      const maxRelativeScroll = maxScroll / this.fullWidth * this.zoom;
      const delta = (Math.abs(e.deltaX) === 0 ? e.deltaY : e.deltaX) * this.zoom * 1.25;
      const position = this.scrollLeft * this.zoom;

      // Values for the update
      const currentSroll = maxScroll * position;
      const newPosition = Math.max(0, currentSroll + delta);
      const newRelativePosition = clamp(newPosition / maxScroll, 0, maxRelativeScroll);
      const scrollLeft = newRelativePosition / this.zoom;

      if (scrollLeft !== this.scrollLeft) {
        this.wf.invoke('scroll', [scrollLeft]);
        this.setScrollLeft(scrollLeft);
      }
    }
  };

  private updatePosition(redraw = true) {
    if (!this.wf.loaded) return;
    const maxScroll = this.scrollWidth;
    const maxRelativeScroll = maxScroll / this.fullWidth * this.zoom;

    this.setScrollLeft(clamp(this.scrollLeft, 0, maxRelativeScroll), redraw);
  }

  private get dataLength() {
    return this.audio?.dataLength ?? 0;
  }

  private getSamplesPerPx() {
    const newValue = this.dataLength / this.fullWidth;

    if (newValue !== this.samplesPerPx) {
      this.samplesPerPx = newValue;
    }

    return this.samplesPerPx;
  }

  private isZooming(e: WheelEvent) {
    return e.ctrlKey || e.metaKey;
  }

  private preventScrollX = (e: WheelEvent) => {
    const [dX, dY] = [Math.abs(e.deltaX), Math.abs(e.deltaY)];

    if (dX >= dY || (this.isZooming(e) && dY >= dX)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private handleResize = () => {
    if (!this.wf.loaded) return;
    requestAnimationFrame(() => {
      const newWidth = this.wrapper.clientWidth;
      const newHeight = this.height;

      this.updateChannels(() => {
        this.layers.forEach(layer => layer.setSize(newWidth, newHeight));
        this.getSamplesPerPx();
        this.draw(false, this.zoom === 1);
      });
    });
  };

  private transferImage(layers: string[] = ['background', 'waveform', 'regions', 'controls']) {
    const main = this.layers.get('main')!;

    main.clear();

    if (layers) {
      const list = Array.from(this.layers).sort((a, b) => {
        return a[1].index - b[1].index;
      }).filter(([_, layer]) => layer.offscreen);

      list.forEach(([name, layer]) => {
        if (name === 'main') return;
        layer.transferTo(main);
      });
    }
  }
}
