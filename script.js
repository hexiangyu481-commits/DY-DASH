/* DY DASH — RaceLab Digital Instrument
 * No network, no packages, no backend. Runs from file://.
 * Layers: Config -> simulator/sample model -> warning rules -> renderer -> controls.
 * Future embedded adapter: replace Simulator.sample() with a sensor sample source.
 */
(() => {
  'use strict';

  // Reference profile: Honda's 2008 US 1.8L 5MT specification, 205/55 R16.
  // Actual FD gearbox, tyres and ECU must be configured for the particular car.
  const GEAR_RATIOS = Object.freeze([0, 3.143, 1.870, 1.235, 0.949, 0.727]);
  const FINAL_DRIVE = 4.294;
  const TYRE_CIRCUMFERENCE_M = Math.PI * (0.4064 + 2 * 0.205 * 0.55);
  const RPM_PER_KPH = Object.freeze(GEAR_RATIOS.map(ratio => ratio * FINAL_DRIVE * 1000 / (60 * TYRE_CIRCUMFERENCE_M)));

  // Demo configuration, NOT a calibrated Honda R18A engine protection map.
  const CONFIG = Object.freeze({
    width: 960,
    height: 540,
    hardwareHeight: 576, // Same 5:3 ratio as 800 x 480.
    sampleHz: 20,
    maxRpm: 7000,
    rpmColorRpm: 3500,
    shiftRpm: 6500,
    engineRedlineRpm: 6800,
    maxSpeed: 180,
    rpmSmoothingSeconds: 0.10,
    sensorSmoothingSeconds: 0.16,
    // 5MT reference only; not confirmation of the user's transmission or ECU.
    drivetrain: Object.freeze({
      rpmPerKph: RPM_PER_KPH,
      upshiftHold: 0.45,
      upshiftDuration: 0.46,
      downshiftDuration: 0.60
    }),
    thresholds: Object.freeze({
      oilTemp: Object.freeze({ yellow: 110, redAbove: 120, critical: 128 }),
      oilPressure: Object.freeze({ yellowAtOrBelow: 3, redBelow: 2, criticalAtOrBelow: 1.6 }),
      coolant: Object.freeze({ yellow: 105, redAbove: 115, critical: 120 }),
      intake: Object.freeze({ yellow: 55, redAbove: 65 }),
      voltage: Object.freeze({ yellowBelow: 12, yellowAbove: 15, redBelow: 11.5, redAbove: 15.5 })
    })
  });

  const METRICS = Object.freeze({
    coolant: { label: '水温', abbr: 'COOLANT', unit: '°C', min: 60, max: 125, decimals: 0, limit: '< 105 °C' },
    voltage: { label: '电压', abbr: 'VOLTAGE', unit: 'V', min: 10, max: 16, decimals: 1 },
    intake: { label: '进气温', abbr: 'INTAKE', unit: '°C', min: 0, max: 70, decimals: 0 },
    oilTemp: { label: '油温', abbr: 'OIL TEMP', unit: '°C', min: 70, max: 130, decimals: 0, limit: '< 110 °C' },
    oilPressure: { label: '油压', abbr: 'OIL PRESS', unit: 'bar', min: 0, max: 6, decimals: 1, limit: '> 3.0 bar' },
    throttle: { label: '节气门', abbr: 'THROTTLE', unit: '%', min: 0, max: 100, decimals: 0 }
  });
  const MODES = ['street', 'track', 'protect'];
  const SCENARIOS = {
    normal: { caption: 'NORMAL DRIVE', state: 'CRUISING' },
    spirited: { caption: 'TRACK RUN', state: 'TRACK RUN' },
    oilDrop: { caption: 'PRESSURE LOSS TEST', state: 'FAULT TEST' },
    hotOil: { caption: 'OIL OVERHEAT TEST', state: 'FAULT TEST' },
    manual: { caption: 'MANUAL SENSOR TEST', state: 'MANUAL' }
  };
  const BASE_SAMPLE = Object.freeze({
    rpm: 62 * RPM_PER_KPH[4], speed: 62, coolant: 92, voltage: 13.8,
    intake: 32, oilTemp: 95, oilPressure: 4.5, throttle: 24, gear: 4
  });
  const LEVELS = { normal: 0, yellow: 1, red: 2, critical: 3 };
  const LEVEL_LABELS = { normal: '正常', yellow: '一级警告', red: '二级警告', critical: '严重故障' };
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, amount) => a + (b - a) * amount;
  const byId = id => document.getElementById(id);

  /** Pure rules: deterministic, independent of DOM and simulator. */
  const WarningRules = {
    classify(key, value) {
      const t = CONFIG.thresholds[key];
      if (!t || !Number.isFinite(value)) return 'normal';
      if (key === 'oilPressure') {
        if (value <= t.criticalAtOrBelow) return 'critical';
        if (value < t.redBelow) return 'red';
        if (value <= t.yellowAtOrBelow) return 'yellow';
      } else if (key === 'voltage') {
        if (value < t.redBelow || value > t.redAbove) return 'red';
        if (value < t.yellowBelow || value > t.yellowAbove) return 'yellow';
      } else {
        if (t.critical !== undefined && value >= t.critical) return 'critical';
        if (value > t.redAbove) return 'red';
        if (value >= t.yellow) return 'yellow';
      }
      return 'normal';
    },
    evaluate(sample) {
      const perMetric = {};
      const warnings = [];
      // Priority protects oil pressure when multiple values share a level.
      for (const key of ['oilPressure', 'oilTemp', 'coolant', 'voltage', 'intake']) {
        const level = this.classify(key, sample[key]);
        perMetric[key] = level;
        if (level !== 'normal') warnings.push({ key, level, value: sample[key] });
      }
      warnings.sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
      return { level: warnings[0]?.level || 'normal', warnings, perMetric };
    }
  };

  /** Shared wheel / engine / selected-gear model. No independent RPM ramps. */
  class Drivetrain {
    constructor() { this.reset('normal'); }
    reset(scenario) {
      this.speed = scenario === 'spirited' ? 36 : scenario === 'oilDrop' ? 92 : scenario === 'hotOil' ? 120 : 62;
      this.gear = scenario === 'spirited' ? 2 : 4;
      this.rpm = this.rpmAt(this.speed, this.gear);
      this.throttle = scenario === 'spirited' ? 90 : 24;
      this.shift = null;
      this.shiftTimer = 0;
      this.cooldown = 0;
      this.state = scenario === 'spirited' ? 'TRACK RUN' : 'CRUISING';
    }
    rpmAt(speed, gear) { return Math.max(800, speed * (CONFIG.drivetrain.rpmPerKph[gear] || 0)); }
    requestShift(nextGear) {
      if (this.shift || nextGear < 1 || nextGear > 5 || nextGear === this.gear) return false;
      const down = nextGear < this.gear;
      const target = this.rpmAt(this.speed, nextGear);
      // Refuse a downshift that would mechanically exceed the matching window.
      if (down && target > CONFIG.shiftRpm - 250) return false;
      this.shift = { from: this.gear, to: nextGear, startRpm: this.rpm, elapsed: 0,
        duration: down ? CONFIG.drivetrain.downshiftDuration : CONFIG.drivetrain.upshiftDuration,
        direction: down ? 'down' : 'up', committed: false };
      this.shiftTimer = 0;
      return true;
    }
    update(dt, input) {
      const braking = input.targetSpeed < this.speed - 0.35;
      let acceleration = clamp((input.targetSpeed - this.speed) * 1.6, -input.brakeRate, input.accelRate);
      // Torque interruption while upshifting; speed coasts instead of jumping.
      if (this.shift?.direction === 'up') acceleration = Math.min(acceleration, -0.7);
      this.speed = clamp(this.speed + acceleration * dt, 0, CONFIG.maxSpeed);
      if (Math.abs(this.speed - input.targetSpeed) < 0.15) this.speed = input.targetSpeed;
      this.cooldown = Math.max(0, this.cooldown - dt);

      if (this.shift) {
        const shift = this.shift;
        shift.elapsed += dt;
        const p = clamp(shift.elapsed / shift.duration, 0, 1);
        const matchingEnd = shift.direction === 'down' ? 0.64 : 0.72;
        const matchingStart = shift.direction === 'down' ? 0.12 : 0.08;
        const blend = clamp((p - matchingStart) / (matchingEnd - matchingStart), 0, 1);
        const smooth = blend * blend * (3 - 2 * blend);
        const syncedRpm = this.rpmAt(this.speed, shift.to);
        this.rpm = lerp(shift.startRpm, syncedRpm, smooth);
        if (shift.direction === 'down') {
          // A real modeled throttle blip precedes lower-gear engagement.
          this.throttle = p > matchingStart && p < matchingEnd ? 18 + 58 * Math.sin(blend * Math.PI) : 0;
          this.state = p >= matchingStart && !shift.committed ? 'REV MATCH' : 'DOWNSHIFT';
        } else {
          this.throttle = p < matchingEnd ? 0 : input.throttle * clamp((p - matchingEnd) / (1 - matchingEnd), 0, 1);
          this.state = 'UPSHIFT';
        }
        // Gear changes at the same sampled instant as matched engine RPM.
        if (!shift.committed && p >= matchingEnd) {
          this.gear = shift.to;
          this.rpm = syncedRpm;
          shift.committed = true;
          this.state = shift.direction === 'down' ? 'DOWNSHIFT' : 'UPSHIFT';
        }
        if (shift.committed) this.rpm = syncedRpm;
        if (p >= 1) { this.shift = null; this.cooldown = 0.16; }
        this.rpm = clamp(this.rpm, 800, CONFIG.maxRpm);
        return;
      }

      if (this.speed < 0.6 && input.targetSpeed < 0.6) {
        this.speed = 0; this.gear = 0; this.rpm = 800; this.throttle = 3; this.state = 'IDLE';
        this.shiftTimer = 0;
        return;
      }
      if (this.gear === 0) this.gear = 1;
      this.rpm = clamp(this.rpmAt(this.speed, this.gear), 800, CONFIG.maxRpm);
      this.throttle = braking ? 0 : input.throttle;
      this.state = braking ? 'BRAKING' : this.speed < 7 ? 'LAUNCH' : input.track ? 'TRACK RUN' : 'CRUISING';
      const upLine = input.track ? CONFIG.shiftRpm : input.upshiftRpm;
      if (!braking && this.gear < 5 && this.rpm >= upLine && this.cooldown === 0) {
        this.shiftTimer += dt;
        if (this.shiftTimer >= CONFIG.drivetrain.upshiftHold || this.rpm >= CONFIG.engineRedlineRpm - 80) this.requestShift(this.gear + 1);
      } else this.shiftTimer = 0;
      if (braking && this.gear > 1 && this.rpm < input.downshiftRpm && this.cooldown === 0) this.requestShift(this.gear - 1);
    }
    sample() {
      return { rpm: this.rpm, speed: this.speed, gear: this.gear || 'N', throttle: this.throttle,
        automaticDrive: true, coupled: !this.shift && this.gear > 0 && this.speed * RPM_PER_KPH[this.gear] >= 800,
        shifting: Boolean(this.shift), gearCommitted: Boolean(this.shift?.committed),
        shiftDirection: this.shift?.direction || '', driveState: this.state };
    }
  }

  /** Sensors share one transmission state; elapsed time freezes when paused. */
  class Simulator {
    constructor() {
      this.scenario = 'normal'; this.elapsed = 0;
      this.manual = { ...BASE_SAMPLE }; this.drive = new Drivetrain();
    }
    select(scenario) {
      if (!SCENARIOS[scenario]) return;
      this.scenario = scenario; this.elapsed = 0;
      if (scenario !== 'manual') this.drive.reset(scenario);
    }
    setManual(values) {
      this.select('manual');
      this.manual = { ...this.manual, ...values, automaticDrive: false, coupled: false,
        shifting: false, gearCommitted: false, shiftDirection: '', driveState: 'MANUAL' };
      let gear = typeof this.manual.gear === 'number' ? this.manual.gear : 3;
      if (this.manual.gear === 'N' && !('rpm' in values)) return;
      while (gear > 1 && this.manual.rpm / CONFIG.drivetrain.rpmPerKph[gear] > CONFIG.maxSpeed) gear--;
      this.manual.gear = gear;
      this.manual.speed = clamp(this.manual.rpm / CONFIG.drivetrain.rpmPerKph[gear], 0, CONFIG.maxSpeed);
    }
    drivingInput() {
      const t = this.elapsed;
      if (this.scenario === 'spirited') {
        // Repeated acceleration, braking and corner-exit segments.
        const phase = t % 42;
        return { targetSpeed: phase < 23 ? 180 : phase < 36 ? 34 : 45,
          throttle: phase < 23 ? 96 : phase < 36 ? 0 : 36,
          accelRate: phase < 36 ? 7 : 4, brakeRate: 11,
          upshiftRpm: CONFIG.shiftRpm, downshiftRpm: 3200, track: true };
      }
      let targetSpeed = 62 + 18 * Math.sin(t * 0.22);
      const cycle = t % 64;
      if (cycle > 38 && cycle < 44) targetSpeed = lerp(62, 0, (cycle - 38) / 6);
      else if (cycle >= 44 && cycle < 51) targetSpeed = 0;
      else if (cycle >= 51) targetSpeed = lerp(0, 62, (cycle - 51) / 13);
      if (this.scenario === 'oilDrop') targetSpeed = 92 + 3 * Math.sin(t * 0.25);
      if (this.scenario === 'hotOil') targetSpeed = 120 + 12 * Math.sin(t * 0.2);
      return { targetSpeed, throttle: this.scenario === 'hotOil' ? 62 : 24,
        accelRate: 5, brakeRate: 12, upshiftRpm: this.scenario === 'normal' ? 3300 : 6500,
        downshiftRpm: 1700, track: false };
    }
    advance(dt) {
      const steps = Math.max(1, Math.ceil(dt * CONFIG.sampleHz));
      const step = dt / steps;
      for (let i = 0; i < steps; i++) {
        this.elapsed += step;
        if (this.scenario !== 'manual') this.drive.update(step, this.drivingInput());
      }
    }
    sample() {
      if (this.scenario === 'manual') return { ...this.manual };
      const t = this.elapsed, driving = this.drive.sample();
      const sample = { ...BASE_SAMPLE, ...driving,
        coolant: 92 + 1.8 * Math.sin(t * 0.12), voltage: 13.8 + 0.08 * Math.sin(t * 0.9),
        intake: 32 + 2 * Math.sin(t * 0.17), oilTemp: 95 + 2.5 * Math.sin(t * 0.08),
        oilPressure: 4.5 + 0.25 * Math.sin(t * 0.2) };
      if (this.scenario === 'spirited') Object.assign(sample, {
        oilTemp: 102 + 10 * (1 - Math.exp(-t / 35)),
        oilPressure: 4.3 + 1.2 * (driving.rpm - 800) / 6200,
        coolant: 97 + 4 * Math.sin(t * 0.1), intake: 36 + 5 * Math.sin(t * 0.12)
      });
      if (this.scenario === 'oilDrop') Object.assign(sample, {
        oilPressure: lerp(5.5, 1.5, clamp(t / 18, 0, 1)), oilTemp: 99 + 3 * (1 - Math.exp(-t / 25))
      });
      if (this.scenario === 'hotOil') Object.assign(sample, {
        oilTemp: lerp(90, 130, clamp(t / 22, 0, 1)), oilPressure: 4.2 - 0.6 * clamp(t / 22, 0, 1),
        coolant: 98 + 6 * clamp(t / 22, 0, 1), intake: 42
      });
      sample.oilTemp = clamp(sample.oilTemp, 90, 130);
      sample.oilPressure = clamp(sample.oilPressure, 1.5, 5.5);
      return sample;
    }
  }


  // Tachometer geometry is independent from sampled data.
  function polar(angle, radius) {
    const radians = angle * Math.PI / 180;
    return { x: 202 + Math.sin(radians) * radius, y: 180 - Math.cos(radians) * radius };
  }
  function arcPath(start, end, radius = 163) {
    const a = polar(start, radius), b = polar(end, radius);
    return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
  }
  function tachometerMarkup() {
    let ticks = '', labels = '';
    for (let i = 0; i <= 35; i++) {
      const angle = -130 + i / 35 * 260;
      const major = i % 5 === 0;
      const a = polar(angle, major ? 179 : 175), b = polar(angle, 185);
      ticks += `<line class="tick ${major ? 'tick-major' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
      if (major) {
        const c = polar(angle, 138);
        labels += `<text class="${i / 35 * CONFIG.maxRpm >= CONFIG.engineRedlineRpm ? 'red-label' : ''}" x="${c.x}" y="${c.y}">${i / 5}</text>`;
      }
    }
    const tip = polar(-130, 162), inner = polar(-130, 144);
    return `<svg class="tachometer" viewBox="0 0 404 310" aria-hidden="true">
      <path class="track" d="${arcPath(-130, 130)}"/>
      <path class="red-zone" d="${arcPath(-130 + CONFIG.engineRedlineRpm / CONFIG.maxRpm * 260, 130)}"/>
      <path class="progress" d="${arcPath(-130, 130)}" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
      ${ticks}${labels}<line class="needle" x1="${inner.x}" y1="${inner.y}" x2="${tip.x}" y2="${tip.y}"/>
    </svg>`;
  }
  function metricMarkup(key, priority = false, protect = false) {
    const m = METRICS[key];
    return `<article class="metric-card ${priority ? 'priority' : ''}" data-metric="${key}" data-severity="normal" aria-label="${m.label}">
      <div class="metric-top"><span>${m.label}</span><span class="metric-abbr">${m.abbr}</span></div>
      <div class="metric-reading"><span class="metric-number" data-value="${key}">${BASE_SAMPLE[key].toFixed(m.decimals)}</span><span class="metric-unit">${m.unit}</span></div>
      <span class="card-warning" hidden></span><div class="metric-track"><span></span></div>
      ${protect ? `<div class="metric-limit"><span class="limit-label">演示正常范围</span><span>${m.limit}</span></div>` : ''}
    </article>`;
  }
  function drivingMarkup(mode) {
    const track = mode === 'track';
    if (track) return `<div class="track-tach"><div class="tach-scale">${Array.from({ length: 8 }, (_, i) => `<span>${i}</span>`).join('')}</div><div class="rpm-bar track-rpm-bar"><span></span><i class="bar-red-zone"></i></div></div>
      <div class="track-performance">
        <div class="track-rpm"><div class="measurement-label">ENGINE SPEED</div><div class="rpm-value" data-value="rpm">2400</div><div class="rpm-unit">RPM</div><div class="rpm-subtitle" data-rpm-caption>POWER BAND</div></div>
        <div class="track-gear-wrap"><div class="gear-box track-gear"><span>GEAR</span><b data-value="gear">3</b></div><div class="gear-caption">GEAR POSITION</div></div>
        <div class="track-speed"><div class="measurement-label">VEHICLE SPEED</div><div class="speed-number" data-value="speed">62</div><div class="speed-unit">km/h</div><div class="state-text" data-state>TRACK RUN</div></div>
      </div><div class="metric-row track-metrics">${['oilPressure', 'oilTemp', 'throttle', 'intake'].map((key, i) => metricMarkup(key, i < 2)).join('')}</div>`;
    return `<div class="driving-main street-main">
      <div class="rpm-gauge"><div class="rpm-side-label">HONDA / CIVIC FD</div>${tachometerMarkup()}
        <div class="rpm-center"><div class="measurement-label">ENGINE SPEED</div><div class="rpm-value" data-value="rpm">2400</div><div class="rpm-unit">RPM</div><div class="rpm-subtitle" data-rpm-caption>STREET / DAILY</div></div>
        <div class="rpm-bar"><span></span></div>
      </div>
      <div class="speed-gauge"><div class="speed-readout"><div class="measurement-label">VEHICLE SPEED</div><div class="speed-number" data-value="speed">62</div><div class="speed-unit">km/h</div></div><div class="gear-box street-gear"><span>GEAR</span><b data-value="gear">3</b></div><div class="drive-state"><span class="state-text" data-state>CRUISING</span></div></div>
    </div><div class="metric-row street-metrics">${['coolant', 'voltage', 'intake', 'oilTemp'].map(key => metricMarkup(key)).join('')}</div>`;
  }

  /** DOM renderer caches nodes. No element creation during animation. */
  class Renderer {
    constructor() {
      byId('view-street').innerHTML = drivingMarkup('street');
      byId('view-track').innerHTML = drivingMarkup('track');
      byId('view-protect').innerHTML = `<div class="health-heading"><div><h2>ENGINE PROTECTION</h2><p>HONDA R18A · 发动机健康</p></div><span class="health-state"><i class="health-dot"></i><span id="health-label">ALL CLEAR</span></span></div><div class="protect-metrics">${['oilPressure', 'oilTemp', 'coolant'].map(key => metricMarkup(key, true, true)).join('')}</div>`;
      byId('shift-lights').innerHTML = Array.from({ length: 10 }, (_, i) => `<span class="shift-light ${i >= 8 ? 'red' : i >= 6 ? 'amber' : ''}"></span>`).join('');
      this.dash = byId('dash');
      this.views = MODES.map(mode => byId(`view-${mode}`));
      this.metricCards = Array.from(document.querySelectorAll('[data-metric]')).map(node => ({
        node, key: node.dataset.metric, value: node.querySelector('.metric-number'),
        bar: node.querySelector('.metric-track span'), warning: node.querySelector('.card-warning')
      }));
      this.rpmNodes = Array.from(document.querySelectorAll('[data-value="rpm"]'));
      this.speedNodes = Array.from(document.querySelectorAll('[data-value="speed"]'));
      this.gearNodes = Array.from(document.querySelectorAll('[data-value="gear"]'));
      this.progressPaths = Array.from(document.querySelectorAll('.progress'));
      this.needles = Array.from(document.querySelectorAll('.needle'));
      this.rpmBars = Array.from(document.querySelectorAll('.rpm-bar span'));
      this.stateNodes = Array.from(document.querySelectorAll('[data-state]'));
      this.rpmCaptions = Array.from(document.querySelectorAll('[data-rpm-caption]'));
      this.lights = Array.from(document.querySelectorAll('.shift-light'));
      this.lightContainer = byId('shift-lights');
      this.shiftCallout = byId('shift-callout');
      this.alertTitle = byId('alert-title');
      this.alertDetail = byId('alert-detail');
      this.alertLevel = byId('alert-level');
      this.alertIcon = byId('alert-icon');
      this.lastWarningSignature = '';
    }
    setText(node, text) { if (node.textContent !== String(text)) node.textContent = text; }
    mode(mode) {
      this.dash.dataset.mode = mode;
      this.views.forEach((view, i) => { view.hidden = MODES[i] !== mode; });
      document.querySelectorAll('[data-mode]').forEach(button => {
        if (button.tagName !== 'BUTTON') return;
        const active = button.dataset.mode === mode;
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      });
      this.setText(byId('next-mode-label'), `NEXT: ${MODES[(MODES.indexOf(mode) + 1) % 3].toUpperCase()}`);
    }
    render(sample, alerts, scenario, elapsed, paused) {
      const rpmFraction = sample.rpm / CONFIG.maxRpm;
      this.rpmNodes.forEach(node => this.setText(node, sample.rpm));
      this.speedNodes.forEach(node => this.setText(node, sample.speed));
      this.gearNodes.forEach(node => this.setText(node, sample.gear));
      this.rpmBars.forEach(node => { node.style.width = `${rpmFraction * 100}%`; });
      this.progressPaths.forEach(node => { node.style.strokeDashoffset = String(100 - rpmFraction * 100); });
      const angle = -130 + rpmFraction * 260;
      const a = polar(angle, 144), b = polar(angle, 166);
      this.needles.forEach(node => {
        node.setAttribute('x1', a.x); node.setAttribute('y1', a.y);
        node.setAttribute('x2', b.x); node.setAttribute('y2', b.y);
      });
      this.metricCards.forEach(card => {
        const metric = METRICS[card.key];
        this.setText(card.value, sample[card.key].toFixed(metric.decimals));
        const level = alerts.perMetric[card.key] || 'normal';
        card.node.dataset.severity = level;
        card.node.setAttribute('aria-label', `${metric.label} ${card.value.textContent} ${metric.unit}，${LEVEL_LABELS[level]}`);
        card.bar.style.width = `${clamp((sample[card.key] - metric.min) / (metric.max - metric.min), 0, 1) * 100}%`;
        card.warning.hidden = level === 'normal';
        this.setText(card.warning, level === 'critical' ? '！严重' : level === 'red' ? '！二级' : '△ 一级');
      });
      this.lights.forEach((node, i) => node.classList.toggle('active', sample.rpm >= 3000 + i * 390));
      const shiftNow = sample.rpm >= CONFIG.shiftRpm;
      this.dash.classList.toggle('rpm-high', sample.rpm > CONFIG.rpmColorRpm);
      this.lightContainer.classList.toggle('shift-now', shiftNow);
      this.dash.classList.toggle('shift-flash', shiftNow);
      this.shiftCallout.hidden = !shiftNow;
      this.rpmCaptions.forEach((node, i) => this.setText(node, shiftNow ? '↑ SHIFT NOW' : i === 0 ? 'STREET / DAILY' : 'POWER BAND'));
      this.dash.dataset.driveState = sample.driveState || SCENARIOS[scenario].state;
      this.stateNodes.forEach(node => this.setText(node, paused ? 'PAUSED' : this.dash.dataset.driveState));
      this.setText(byId('scenario-caption'), SCENARIOS[scenario].caption);
      this.dash.classList.toggle('paused', paused);
      this.setText(byId('run-state'), paused ? 'HOLD' : scenario === 'manual' ? 'MANUAL' : 'LIVE');
      this.dash.dataset.severity = alerts.level;
      // Live region changes only for warning identity/severity, never every frame.
      const signature = alerts.warnings.map(w => `${w.key}:${w.level}`).join('|');
      if (signature !== this.lastWarningSignature || !this.initializedAlerts) {
        this.initializedAlerts = true;
        this.lastWarningSignature = signature;
        const severe = alerts.level === 'critical';
        this.setText(this.alertIcon, alerts.level === 'normal' ? '✓' : '⚠');
        this.setText(this.alertTitle, alerts.level === 'normal' ? 'ENGINE NORMAL' : severe ? 'ENGINE PROTECTION' : 'ENGINE WARNING');
        this.setText(this.alertLevel, { normal: 'ALL CLEAR', yellow: 'LEVEL 01', red: 'LEVEL 02', critical: 'CRITICAL' }[alerts.level]);
        this.setText(byId('health-label'), { normal: 'ALL CLEAR', yellow: 'CHECK ENGINE', red: 'HIGH RISK', critical: 'CRITICAL' }[alerts.level]);
        const descriptions = alerts.warnings.map(w => {
          const name = METRICS[w.key].label;
          return w.key === 'oilPressure' ? `${name}过低` : w.key === 'voltage' ? `${name}异常` : `${name}过高`;
        });
        this.setText(this.alertDetail, alerts.level === 'normal' ? '发动机状态正常' : `${descriptions.join(' · ')}${severe ? ' · 严重故障' : ''}`);
      }
      const seconds = Math.floor(elapsed);
      this.setText(byId('clock'), [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'));
    }
  }

  class DashController {
    constructor() {
      this.simulator = new Simulator();
      this.renderer = new Renderer();
      this.mode = 'street';
      this.paused = false;
      this.totalTime = 0;
      this.sampleAccumulator = 0;
      this.target = { ...BASE_SAMPLE };
      this.display = { ...BASE_SAMPLE };
      this.criticalLatch = false;
      this.lastTimestamp = null;
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.bindControls();
      this.resize();
      this.renderer.mode(this.mode);
      this.draw();
      this.frame = this.frame.bind(this);
      requestAnimationFrame(this.frame);
    }
    setMode(mode) {
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      this.renderer.mode(mode);
    }
    nextMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); }
    selectScenario(scenario) {
      if (!SCENARIOS[scenario]) return;
      this.simulator.select(scenario);
      this.criticalLatch = false;
      this.target = this.simulator.sample();
      this.display = { ...this.target };
      this.setPaused(false);
      document.querySelectorAll('[data-scenario]').forEach(button => {
        const active = button.dataset.scenario === scenario;
        button.classList.toggle('selected', active);
        button.setAttribute('aria-pressed', String(active));
      });
      this.draw();
    }
    setPaused(value) {
      this.paused = Boolean(value);
      byId('pause').setAttribute('aria-pressed', String(this.paused));
      byId('pause').textContent = this.paused ? '▶ 继续' : 'Ⅱ 暂停';
      this.lastTimestamp = null;
      this.draw();
    }
    setManual(values) {
      const validated = {};
      for (const [key, value] of Object.entries(values)) {
        if (!(key in BASE_SAMPLE) || key === 'gear' || !Number.isFinite(Number(value))) continue;
        const m = METRICS[key];
        const min = key === 'rpm' ? 800 : key === 'speed' ? 0 : key === 'oilPressure' ? 1.5 : key === 'oilTemp' ? 90 : m?.min;
        const max = key === 'rpm' ? 7000 : key === 'speed' ? 180 : key === 'oilPressure' ? 5.5 : m?.max;
        validated[key] = clamp(Number(value), min, max);
      }
      if (this.simulator.scenario !== 'manual') this.simulator.manual = { ...this.target };
      this.simulator.setManual(validated);
      this.target = this.simulator.sample();
      // A manual input also works while paused: exact immediate boundary checks.
      this.display = { ...this.target };
      document.querySelectorAll('[data-scenario]').forEach(button => {
        button.classList.remove('selected'); button.setAttribute('aria-pressed', 'false');
      });
      this.syncSliders();
      this.draw();
    }
    syncSliders() {
      for (const input of document.querySelectorAll('[data-parameter]')) {
        const key = input.dataset.parameter;
        input.value = String(clamp(this.target[key], Number(input.min), Number(input.max)));
        const value = Number(input.value);
        byId(`${input.id}-output`).textContent = `${value.toFixed(key === 'oilPressure' ? 1 : 0)} ${key === 'rpm' ? 'rpm' : METRICS[key].unit}`;
      }
    }
    reset() {
      this.totalTime = 0;
      this.sampleAccumulator = 0;
      this.display = { ...BASE_SAMPLE };
      this.target = { ...BASE_SAMPLE };
      this.simulator.manual = { ...BASE_SAMPLE };
      this.setMode('street');
      this.selectScenario('normal');
      this.syncSliders();
    }
    quantizedSample() {
      // Evaluate the displayed precision: a displayed 120 °C must not be red.
      const sample = { ...this.target };
      for (const key of Object.keys(BASE_SAMPLE)) sample[key] = key === 'gear' ? this.target.gear : this.display[key];
      sample.speed = Math.round(sample.speed);
      // One visual tuple: selected gear and RPM refer to the same displayed speed.
      // During clutch-open rev matching RPM is deliberately free from wheel speed.
      if (this.target.automaticDrive && (this.target.coupled || this.target.gearCommitted)) {
        sample.rpm = clamp(sample.speed * (RPM_PER_KPH[sample.gear] || 0), 800, CONFIG.maxRpm);
      }
      sample.rpm = Math.round(sample.rpm / 10) * 10;
      for (const [key, metric] of Object.entries(METRICS)) sample[key] = Number(sample[key].toFixed(metric.decimals));
      sample.gear = this.target.gear;
      return sample;
    }
    draw() {
      const sample = this.quantizedSample();
      this.alerts = WarningRules.evaluate(sample);
      if (this.alerts.level === 'critical' && !this.criticalLatch) {
        this.criticalLatch = true;
        if (byId('auto-protect').checked) this.setMode('protect');
      } else if (this.alerts.level !== 'critical') {
        this.criticalLatch = false;
      }
      this.renderer.render(sample, this.alerts, this.simulator.scenario, this.totalTime, this.paused);
    }
    update(dt) {
      if (this.paused) return;
      this.totalTime += dt;
      this.simulator.advance(dt);
      this.sampleAccumulator += dt;
      if (this.sampleAccumulator >= 1 / CONFIG.sampleHz) {
        this.sampleAccumulator %= 1 / CONFIG.sampleHz;
        this.target = this.simulator.sample();
      }
      for (const key of Object.keys(BASE_SAMPLE)) {
        if (key === 'gear') continue;
        const tau = key === 'rpm' || key === 'speed' ? CONFIG.rpmSmoothingSeconds : CONFIG.sensorSmoothingSeconds;
        const alpha = this.reducedMotion.matches ? 1 : 1 - Math.exp(-dt / tau);
        this.display[key] = lerp(this.display[key], this.target[key], alpha);
      }
    }
    frame(timestamp) {
      // Background tabs freeze elapsed time. No sudden warning jumps on return.
      const dt = this.lastTimestamp === null || document.hidden ? 0 : clamp((timestamp - this.lastTimestamp) / 1000, 0, 0.1);
      this.lastTimestamp = timestamp;
      this.update(dt);
      this.draw();
      requestAnimationFrame(this.frame);
    }
    resize() {
      const viewport = byId('screen-viewport');
      const width = viewport.clientWidth;
      if (width <= 0) return;
      const height = viewport.classList.contains('hardware-ratio') ? CONFIG.hardwareHeight : CONFIG.height;
      // Explicit container height: the absolute canvas cannot size its parent.
      // Keep working in browsers/previews that ignore CSS aspect-ratio.
      const viewportHeight = `${width * height / CONFIG.width}px`;
      if (viewport.style.height !== viewportHeight) viewport.style.height = viewportHeight;
      viewport.style.paddingBottom = '0px';
      this.renderer.dash.style.height = `${height}px`;
      this.renderer.dash.style.transform = `scale(${width / CONFIG.width})`;
    }
    bindControls() {
      document.querySelectorAll('button[data-mode]').forEach(button => button.addEventListener('click', () => this.setMode(button.dataset.mode)));
      document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => this.selectScenario(button.dataset.scenario)));
      byId('next-mode').addEventListener('click', () => this.nextMode());
      byId('pause').addEventListener('click', () => this.setPaused(!this.paused));
      byId('reset').addEventListener('click', () => this.reset());
      byId('hardware-ratio').addEventListener('change', event => {
        byId('screen-viewport').classList.toggle('hardware-ratio', event.target.checked);
        byId('dash').classList.toggle('hardware-ratio', event.target.checked);
        byId('resolution-caption').textContent = event.target.checked ? '800 × 480 · DIGITAL INSTRUMENT' : '16:9 · DIGITAL INSTRUMENT';
        this.resize();
      });
      byId('manual-panel').addEventListener('toggle', () => { if (byId('manual-panel').open) this.syncSliders(); });
      document.querySelectorAll('[data-parameter]').forEach(input => input.addEventListener('input', () => this.setManual({ [input.dataset.parameter]: Number(input.value) })));
      byId('auto-protect').addEventListener('change', event => {
        if (event.target.checked && this.alerts?.level === 'critical') this.setMode('protect');
      });
      byId('fullscreen').addEventListener('click', async () => {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else if (byId('dash').closest('.cluster-shell').requestFullscreen) await byId('dash').closest('.cluster-shell').requestFullscreen();
          else byId('fullscreen').title = '当前浏览器不支持全屏';
        } catch { byId('fullscreen').title = '全屏未开启，请允许浏览器全屏'; }
      });
      document.addEventListener('fullscreenchange', () => {
        byId('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '全屏仪表');
        this.resize();
      });
      document.querySelector('.mode-tabs').addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const i = MODES.indexOf(this.mode);
        const target = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (i + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
        this.setMode(MODES[target]);
        byId(`tab-${MODES[target]}`).focus();
      });
      document.addEventListener('keydown', event => {
        if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
        if (event.target.closest('input,button,summary,textarea,select,[contenteditable="true"]')) return;
        if (event.key.toLowerCase() === 'm') { event.preventDefault(); this.nextMode(); }
        if (event.code === 'Space') { event.preventDefault(); this.setPaused(!this.paused); }
        if (/^[1-4]$/.test(event.key)) this.selectScenario(['normal', 'spirited', 'oilDrop', 'hotOil'][Number(event.key) - 1]);
      });
      document.addEventListener('visibilitychange', () => { this.lastTimestamp = null; });
      if ('ResizeObserver' in window) new ResizeObserver(() => this.resize()).observe(byId('screen-viewport'));
      else window.addEventListener('resize', () => this.resize());
    }
  }

  const controller = new DashController();
  // Small, explicit integration/debug seam; never writes files or calls a service.
  window.DYDash = Object.freeze({
    config: CONFIG,
    metrics: METRICS,
    warningRules: WarningRules,
    setMode: mode => controller.setMode(mode),
    setScenario: scenario => controller.selectScenario(scenario),
    setManual: values => controller.setManual(values),
    setPaused: value => controller.setPaused(value),
    reset: () => controller.reset(),
    getState: () => ({ mode: controller.mode, scenario: controller.simulator.scenario,
      paused: controller.paused, elapsed: controller.totalTime,
      sample: controller.quantizedSample(), alerts: WarningRules.evaluate(controller.quantizedSample()) })
  });
})();
