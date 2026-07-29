/**
 * Ambience, synthesised on the fly with WebAudio — no audio files.
 *
 * Wind through the valley is filtered noise with a slow gust envelope; water is
 * a second noise band that comes up as you approach the lake or the river;
 * birds call during the day and crickets take over at night. The city adds a
 * low traffic rumble and the odd distant horn. Footsteps are short noise bursts
 * shaped by whatever you are walking on. The hoverboard adds a low electric
 * hum, turbine whine, speed-driven air rush, mount chirps and collision thumps.
 *
 * Everything is started from a user gesture (the button that launches the
 * world), which is what browsers require.
 */

import { clamp } from './noise.js';

export class Ambience {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.started = false;
    this._nextBird = 3;
    this._nextCricket = 1;
    this._nextHorn = 12;
    this._stepDistance = 0;
    this._boardMounted = false;
    this._previousBoardSpeed = 0;
    this._impactCooldown = 0;
  }

  start() {
    if (this.started) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    this.ctx = new AudioCtx();
    this.started = true;

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.9 : 0;
    this.master.connect(ctx.destination);

    // A couple of seconds of noise, looped, feeds everything.
    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;    // a little brown noise for body
      data[i] = clamp(last * 3.5 + white * 0.35, -1, 1);
    }
    this.noiseBuffer = buffer;

    // --- wind ---------------------------------------------------------------
    this.windSource = ctx.createBufferSource();
    this.windSource.buffer = buffer;
    this.windSource.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.12;
    this.windSource.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.windSource.start();

    // A thin whistle on top for exposed high ground.
    this.gustSource = ctx.createBufferSource();
    this.gustSource.buffer = buffer;
    this.gustSource.loop = true;
    this.gustFilter = ctx.createBiquadFilter();
    this.gustFilter.type = 'bandpass';
    this.gustFilter.frequency.value = 1100;
    this.gustFilter.Q.value = 3.2;
    this.gustGain = ctx.createGain();
    this.gustGain.gain.value = 0;
    this.gustSource.connect(this.gustFilter).connect(this.gustGain).connect(this.master);
    this.gustSource.start();

    // Fast movement gets its own brighter rush, separate from the weather.
    this.rushSource = ctx.createBufferSource();
    this.rushSource.buffer = buffer;
    this.rushSource.loop = true;
    this.rushHigh = ctx.createBiquadFilter();
    this.rushHigh.type = 'highpass';
    this.rushHigh.frequency.value = 450;
    this.rushLow = ctx.createBiquadFilter();
    this.rushLow.type = 'lowpass';
    this.rushLow.frequency.value = 2600;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;
    this.rushSource.connect(this.rushHigh).connect(this.rushLow).connect(this.rushGain).connect(this.master);
    this.rushSource.start();

    // --- water --------------------------------------------------------------
    this.waterSource = ctx.createBufferSource();
    this.waterSource.buffer = buffer;
    this.waterSource.loop = true;
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'bandpass';
    this.waterFilter.frequency.value = 900;
    this.waterFilter.Q.value = 0.9;
    this.waterHigh = ctx.createBiquadFilter();
    this.waterHigh.type = 'highshelf';
    this.waterHigh.frequency.value = 2200;
    this.waterHigh.gain.value = 5;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterSource.connect(this.waterFilter).connect(this.waterHigh).connect(this.waterGain).connect(this.master);
    this.waterSource.start();

    // --- the city -----------------------------------------------------------
    // A low rumble of everything at once: tyres, plant rooms, distance.
    this.citySource = ctx.createBufferSource();
    this.citySource.buffer = buffer;
    this.citySource.loop = true;
    this.cityFilter = ctx.createBiquadFilter();
    this.cityFilter.type = 'lowpass';
    this.cityFilter.frequency.value = 220;
    this.cityFilter.Q.value = 1.4;
    this.cityGain = ctx.createGain();
    this.cityGain.gain.value = 0;
    this.citySource.connect(this.cityFilter).connect(this.cityGain).connect(this.master);
    this.citySource.start();

    // --- hoverboard ---------------------------------------------------------
    this.boardBus = ctx.createGain();
    this.boardBus.gain.value = 0;
    this.boardBus.connect(this.master);

    // A low, slightly dirty electric motor tone.
    this.boardHum = ctx.createOscillator();
    this.boardHum.type = 'sawtooth';
    this.boardHum.frequency.value = 54;
    this.boardHumFilter = ctx.createBiquadFilter();
    this.boardHumFilter.type = 'lowpass';
    this.boardHumFilter.frequency.value = 310;
    this.boardHumGain = ctx.createGain();
    this.boardHumGain.gain.value = 0.075;
    this.boardHum.connect(this.boardHumFilter).connect(this.boardHumGain).connect(this.boardBus);
    this.boardHum.start();

    // A detuned upper layer gives throttle and lift some audible bite.
    this.boardWhine = ctx.createOscillator();
    this.boardWhine.type = 'triangle';
    this.boardWhine.frequency.value = 118;
    this.boardWhine.detune.value = 9;
    this.boardWhineFilter = ctx.createBiquadFilter();
    this.boardWhineFilter.type = 'bandpass';
    this.boardWhineFilter.frequency.value = 520;
    this.boardWhineFilter.Q.value = 1.1;
    this.boardWhineGain = ctx.createGain();
    this.boardWhineGain.gain.value = 0.035;
    this.boardWhine.connect(this.boardWhineFilter).connect(this.boardWhineGain).connect(this.boardBus);
    this.boardWhine.start();

    // Filtered noise acts as the thruster exhaust rather than another pure tone.
    this.boardThrustSource = ctx.createBufferSource();
    this.boardThrustSource.buffer = buffer;
    this.boardThrustSource.loop = true;
    this.boardThrustFilter = ctx.createBiquadFilter();
    this.boardThrustFilter.type = 'bandpass';
    this.boardThrustFilter.frequency.value = 900;
    this.boardThrustFilter.Q.value = 0.75;
    this.boardThrustGain = ctx.createGain();
    this.boardThrustGain.gain.value = 0;
    this.boardThrustSource.connect(this.boardThrustFilter).connect(this.boardThrustGain).connect(this.boardBus);
    this.boardThrustSource.start();
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.1);
    if (on && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** @param {object} s scene state: daylight, water proximity, altitude, motion */
  update(dt, s) {
    if (!this.started || !this.ctx) return;
    const t = this.ctx.currentTime;

    // The board is available through the public world handle. Keeping this read
    // here avoids plumbing audio-only fields through the main frame loop.
    const board = s.hoverboard || window.openworld?.state?.hoverboard || null;
    const mounted = !!board?.mounted;
    const boardSpeed = mounted ? Math.abs(board.forwardSpeed || 0) : 0;
    const verticalSpeed = mounted ? (board.verticalSpeed || 0) : 0;

    // Wind rises with altitude and exposure, and breathes on a slow cycle.
    const exposure = clamp((s.altitude - 8) / 90, 0, 1);
    const gust = 0.55 + 0.45 * Math.sin(s.time * 0.21) * Math.sin(s.time * 0.077 + 1.3);
    const windLevel = (0.05 + exposure * 0.16) * (0.55 + gust * 0.7);
    this.windGain.gain.setTargetAtTime(windLevel, t, 0.4);
    this.windFilter.frequency.setTargetAtTime(320 + exposure * 620 + gust * 260, t, 0.5);
    this.gustGain.gain.setTargetAtTime(exposure * exposure * 0.035 * gust, t, 0.6);

    // Air rushing past the rider. It starts gently and gets much louder above
    // ordinary running speed so the hoverboard actually feels fast.
    const motionSpeed = Math.max(s.speed || 0, boardSpeed);
    const rush = clamp((motionSpeed - 3) / 28, 0, 1);
    const rushLevel = Math.pow(rush, 1.35) * (mounted ? 0.20 : 0.09);
    this.rushGain.gain.setTargetAtTime(rushLevel, t, mounted ? 0.12 : 0.3);
    this.rushHigh.frequency.setTargetAtTime(380 + rush * 900, t, 0.2);
    this.rushLow.frequency.setTargetAtTime(1800 + rush * 3000, t, 0.2);

    // Hoverboard motor. Vertical speed is a useful proxy for trigger thrust,
    // while forward speed pushes both pitch and filter brightness upward.
    const speedRatio = clamp(boardSpeed / 34, 0, 1);
    const climb = clamp(Math.max(0, verticalSpeed) / 15, 0, 1);
    const load = clamp(speedRatio * 0.75 + climb * 0.9, 0, 1);
    this.boardBus.gain.setTargetAtTime(mounted ? 1 : 0, t, mounted ? 0.08 : 0.18);
    this.boardHum.frequency.setTargetAtTime(52 + speedRatio * 58 + climb * 34, t, 0.08);
    this.boardHumFilter.frequency.setTargetAtTime(280 + load * 650, t, 0.1);
    this.boardHumGain.gain.setTargetAtTime(0.055 + load * 0.055, t, 0.1);
    this.boardWhine.frequency.setTargetAtTime(112 + speedRatio * 190 + climb * 150, t, 0.07);
    this.boardWhineFilter.frequency.setTargetAtTime(450 + load * 1500, t, 0.1);
    this.boardWhineGain.gain.setTargetAtTime(0.02 + load * 0.055, t, 0.1);
    this.boardThrustFilter.frequency.setTargetAtTime(700 + climb * 2200 + speedRatio * 700, t, 0.08);
    this.boardThrustGain.gain.setTargetAtTime(0.015 + climb * 0.14 + speedRatio * 0.035, t, 0.08);

    if (mounted !== this._boardMounted) {
      this.boardPowerCue(mounted);
      this._boardMounted = mounted;
      this._previousBoardSpeed = boardSpeed;
    }

    // A sudden speed loss is almost always the board clipping a wall. Give it a
    // blunt synthetic thump so the haptics are not doing all the work.
    this._impactCooldown = Math.max(0, this._impactCooldown - dt);
    const speedDrop = this._previousBoardSpeed - boardSpeed;
    if (mounted && this._impactCooldown <= 0 && this._previousBoardSpeed > 7 && speedDrop > 3.5) {
      this.boardImpact(clamp(speedDrop / 14, 0.25, 1));
      this._impactCooldown = 0.18;
    }
    this._previousBoardSpeed = boardSpeed;

    // Water: louder and brighter the closer you get.
    const near = clamp(1 - s.waterDistance / 45, 0, 1);
    const level = Math.pow(near, 1.6) * (s.swimming ? 0.30 : 0.17) + (s.riverNear ? 0.10 : 0);
    this.waterGain.gain.setTargetAtTime(level, t, 0.5);
    this.waterFilter.frequency.setTargetAtTime(700 + near * 700 + (s.riverNear ? 500 : 0), t, 0.6);

    // The city, if we are in it.
    const urban = clamp(s.urban || 0, 0, 1);
    this.cityGain.gain.setTargetAtTime(Math.pow(urban, 1.3) * 0.16, t, 0.9);
    this.cityFilter.frequency.setTargetAtTime(170 + urban * 260, t, 0.9);
    this._nextHorn -= dt;
    if (this._nextHorn <= 0) {
      this._nextHorn = 5 + Math.random() * 16;
      if (urban > 0.25 && Math.random() < urban) this.horn(urban);
    }

    // Wildlife.
    this._nextBird -= dt;
    if (this._nextBird <= 0) {
      this._nextBird = 2.5 + Math.random() * 9;
      if (s.daylight > 0.35 && s.altitude < 95 && Math.random() < 0.75 * (1 - urban)) this.birdCall();
    }
    this._nextCricket -= dt;
    if (this._nextCricket <= 0) {
      this._nextCricket = 0.35 + Math.random() * 0.5;
      if (s.daylight < 0.25 && s.altitude < 60 && Math.random() > urban) this.cricket();
    }

    // Footsteps, driven by distance travelled rather than a timer. Mounted
    // riders are explicitly excluded so the board does not wear imaginary shoes.
    if (!mounted && s.grounded && !s.swimming && s.speed > 0.4) {
      this._stepDistance += s.speed * dt;
      const stride = s.speed > 5 ? 1.55 : 1.05;
      if (this._stepDistance > stride) {
        this._stepDistance = 0;
        this.footstep(s.surface);
      }
    } else if (!mounted && s.swimming) {
      this._stepDistance += dt;
      if (this._stepDistance > 1.4) {
        this._stepDistance = 0;
        this.footstep('water');
      }
    } else if (mounted) {
      this._stepDistance = 0;
    }
  }

  // --- one-shots -----------------------------------------------------------

  noiseBurst(duration, filterType, freq, q, gain, sweepTo = null) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + duration * 0.15);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  boardPowerCue(on) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const start = on ? 115 : 260;
    const end = on ? 520 : 82;
    osc.frequency.setValueAtTime(start, t);
    osc.frequency.exponentialRampToValueAtTime(end, t + (on ? 0.24 : 0.18));
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(on ? 0.075 : 0.05, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (on ? 0.3 : 0.22));
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.34);
  }

  boardImpact(strength = 0.5) {
    this.noiseBurst(0.16, 'lowpass', 190 + strength * 170, 0.7, 0.07 + strength * 0.11, 75);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(92 + strength * 28, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 + strength * 0.07, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  footstep(surface = 'grass') {
    if (!this.started) return;
    switch (surface) {
      case 'rock':
        this.noiseBurst(0.13, 'bandpass', 1500 + Math.random() * 900, 1.4, 0.09);
        break;
      case 'water':
        this.noiseBurst(0.34, 'bandpass', 700 + Math.random() * 500, 0.8, 0.11, 2600);
        break;
      case 'snow':
        this.noiseBurst(0.17, 'lowpass', 900 + Math.random() * 400, 0.8, 0.07);
        break;
      default:
        this.noiseBurst(0.16, 'bandpass', 480 + Math.random() * 420, 1.1, 0.075);
    }
  }

  /** A car horn, somewhere out in the grid. Two detuned squares, short. */
  horn(level) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const base = 320 + Math.random() * 180;
    const length = 0.18 + Math.random() * 0.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.016 * level, t + 0.02);
    g.gain.setValueAtTime(0.016 * level, t + length * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1400;
    for (const detune of [0, 1.19]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = base * (1 + detune * 0.5);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + length + 0.05);
    }
    filter.connect(g).connect(this.master);
  }

  birdCall() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = 2 + ((Math.random() * 3) | 0);
    const base = 1700 + Math.random() * 1700;
    for (let i = 0; i < notes; i++) {
      const start = t + i * (0.09 + Math.random() * 0.09);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      const f0 = base * (0.85 + Math.random() * 0.4);
      osc.frequency.setValueAtTime(f0, start);
      osc.frequency.exponentialRampToValueAtTime(f0 * (0.72 + Math.random() * 0.7), start + 0.07);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.045, start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.085);
      osc.connect(g).connect(this.master);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }

  cricket() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const freq = 3900 + Math.random() * 900;
    for (let i = 0; i < 4; i++) {
      const start = t + i * 0.035;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.012, start + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.028);
      osc.connect(g).connect(this.master);
      osc.start(start);
      osc.stop(start + 0.04);
    }
  }
}
