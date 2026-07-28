/**
 * DOM overlay (start screen, loading, notices) and the little wrist panel that
 * shows the time of day inside the headset.
 */

import * as THREE from 'three';
import { QUALITY } from './config.js';

export class UI {
  constructor() {
    this.overlay = document.getElementById('overlay');
    this.loading = document.getElementById('loading');
    this.fill = document.getElementById('progress-fill');
    this.label = document.getElementById('progress-label');
    this.actions = document.getElementById('actions');
    this.enterVR = document.getElementById('enter-vr');
    this.enterDesktop = document.getElementById('enter-desktop');
    this.note = document.getElementById('xr-note');
    this.hud = document.getElementById('hud');
    this.notice = document.getElementById('notice');
    this.stats = document.getElementById('stats');
    this._noticeTimer = 0;
  }

  progress(fraction, text) {
    this.fill.style.width = `${Math.round(fraction * 100)}%`;
    if (text) this.label.textContent = text;
  }

  ready() {
    this.loading.hidden = true;
    this.actions.hidden = false;
  }

  hideOverlay() {
    this.overlay.hidden = true;
    this.hud.hidden = false;
  }

  showOverlay() {
    this.overlay.hidden = false;
    this.hud.hidden = true;
  }

  /** Wire the quality buttons; changing detail reloads with a new setting. */
  bindQuality(current, onChange) {
    for (const button of document.querySelectorAll('[data-quality]')) {
      const value = button.dataset.quality;
      button.setAttribute('aria-pressed', String(value === current));
      button.addEventListener('click', () => onChange(value));
    }
  }

  setNote(text) {
    this.note.textContent = text;
  }

  showNotice(text, ms = 2200) {
    this.notice.textContent = text;
    this.notice.classList.add('show');
    clearTimeout(this._noticeTimer);
    this._noticeTimer = setTimeout(() => this.notice.classList.remove('show'), ms);
  }

  setStats(text) {
    this.stats.textContent = text;
  }
}

/** Read the requested quality from the URL, storage, or the device. */
export function resolveQuality() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('q') || params.get('quality') || localStorage.getItem('openworld.quality');
  if (requested && QUALITY[requested]) return requested;
  const ua = navigator.userAgent;
  if (/Quest|OculusBrowser|Pico|VR/i.test(ua)) return 'medium';
  if (/Android|iPhone|iPad/i.test(ua)) return 'low';
  return 'high';
}

/**
 * A small readout strapped to the left wrist: clock, height and heading. It is
 * the only UI inside the headset, and it stays out of the way until you look
 * at it.
 */
export class WristPanel {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 160;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.PlaneGeometry(0.10, 0.05);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    // Sits just above the back of the hand, tilted toward the face.
    this.mesh.position.set(0, 0.035, 0.055);
    this.mesh.rotation.set(-Math.PI / 2.5, 0, 0);
    parent.add(this.mesh);
    this._accum = 0;
  }

  update(dt, state) {
    this._accum += dt;
    if (this._accum < 0.25) return;
    this._accum = 0;

    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(8, 14, 22, 0.78)';
    roundRect(ctx, 2, 2, w - 4, h - 4, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 190, 225, 0.35)';
    ctx.lineWidth = 2;
    roundRect(ctx, 2, 2, w - 4, h - 4, 16);
    ctx.stroke();

    ctx.fillStyle = '#dceefb';
    ctx.font = '600 46px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(state.clock, 22, 22);

    ctx.font = '500 22px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(180, 210, 235, 0.75)';
    ctx.fillText(state.compass, 22, 80);
    ctx.fillText(`${state.altitude} m`, 22, 112);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(150, 185, 215, 0.6)';
    ctx.font = '500 20px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(state.fps, w - 24, 112);
    ctx.textAlign = 'left';

    this.texture.needsUpdate = true;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 0..1 through the day as a 24 h clock string. */
export function formatClock(t) {
  const total = ((t % 1) + 1) % 1 * 24;
  const hours = Math.floor(total);
  const minutes = Math.floor((total - hours) * 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Compass letter for a world-space heading (north is -Z). */
export function formatCompass(direction) {
  let angle = Math.atan2(direction.x, -direction.z) * (180 / Math.PI);
  if (angle < 0) angle += 360;
  return `${COMPASS[Math.round(angle / 45) % 8]}  ${Math.round(angle)}°`;
}
