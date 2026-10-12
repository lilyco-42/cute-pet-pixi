// 日常行为状态机 —— 规格抄自 nctype/DesktopSeyana
// (pet_window.gd 的 enter_state/_build_*/_update_state_movement + app.gd 的 choose_random_action)
//
// 状态 = 一串「相位(phase)」：{ clip, loops, movement, speedMul }
//   loops = 无限(-1) 时靠 duration 超时结束（走路就是这种）
// 队列播完 -> after：'idle' 或 'choose'（按权重抽下一个动作，并排除上一个）
// 行为表放在**资产包里**（pack.behaviors），所以换素材/换行为都不动运行时。

export const DEFAULT_BEHAVIOR = {
  initial: 'idle',
  choose: { weights: { idle: 1 } },
  states: { idle: { phases: [{ clip: 'idle', loops: -1 }], after: 'idle' } },
};

export class Behavior {
  constructor(stage, pet, table, log) {
    this.stage = stage;
    this.pet = pet;
    this.t = table || DEFAULT_BEHAVIOR;
    this.log = log || (function () {});
    this.state = null;
    this.queue = [];
    this.pi = -1;
    this.phaseClip = null;
    this.phaseLoops = 1;
    this.phaseTime = 0;
    this.phaseDur = 0;
    this.mode = '';
    this.speedMul = 1;
    this.dir = { x: 1, y: 0 };
    this.deadline = 0;
    this.clock = 0;
    this.last = '';
    this.probe = null;
    this.lastPos = null;
    this.enter(this.t.initial || 'idle', 'start');
  }

  clipSeconds(id) {
    const d = this.stage.clipDuration ? this.stage.clipDuration(id) : 0;
    return d > 0 ? d : 0.5;
  }

  pickOne(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  choose() {
    const cfg = this.t.choose || {};
    const w = Object.assign({}, cfg.weights || {});
    const exclude = cfg.excludePrevious === undefined ? true : cfg.excludePrevious;
    if (exclude && Object.keys(w).length > 1 && w[this.last] !== undefined) delete w[this.last];
    const keys = Object.keys(w);
    if (!keys.length) return 'idle';
    let total = 0;
    for (const k of keys) total += Number(w[k]);
    let roll = Math.random() * total;
    for (const k of keys) {
      roll -= Number(w[k]);
      if (roll <= 0) return k;
    }
    return keys[0];
  }

  buildQueue(def) {
    const q = [];
    for (const raw of def.phases || []) {
      const p = Object.assign({}, raw);
      if (p.pick) {
        const roll = Math.random();
        let chosen = p.pick[p.pick.length - 1];
        for (const opt of p.pick) {
          const chance = opt.chance === undefined ? 1 : opt.chance;
          if (roll < chance) { chosen = opt; break; }
        }
        p.clip = chosen.clip;
        p.speedMul = chosen.speedMul || 1;
        if (chosen.loops !== undefined) p.loops = chosen.loops;
        delete p.pick;
      }
      q.push(p);
    }
    return q;
  }

  enter(state, reason) {
    let def = this.t.states[state];
    if (!def) {
      this.log('behavior: 状态 ' + state + ' 不在表里，回落 idle');
      state = 'idle';
      def = this.t.states.idle;
      if (!def) return;
    }
    this.state = state;
    this.queue = this.buildQueue(def);
    this.pi = -1;
    this.mode = '';
    this.deadline = 0;
    this._after = def.after || 'idle';
    this.log('behavior: -> ' + state + ' (' + reason + ') [' + this.queue.map(function (p) { return p.clip; }).join(' ') + ']');
    this._next();
  }

  _next() {
    this.pi += 1;
    if (this.pi >= this.queue.length) {
      if (this._after === 'choose') {
        const pick = this.choose();
        this.last = pick;
        this.enter(pick, 'random');
      } else {
        this.enter(this._after, 'sequence done');
      }
      return;
    }
    const p = this.queue[this.pi];
    this.phaseClip = p.clip;
    this.phaseTime = 0;
    this.speedMul = Number(p.speedMul || 1);
    this.mode = String(p.movement || '');
    const loops = Array.isArray(p.loops) ? this.pickOne(p.loops) : (p.loops === undefined ? 1 : p.loops);
    this.phaseLoops = Number(loops);
    this.stage.play(this.phaseClip);
    if (this.phaseLoops === -1) {
      const d = p.duration || [0, 0];
      const lo = Number(d[0] || 0);
      const hi = Math.max(lo, Number(d[1] || 0));
      this.deadline = this.clock + lo + Math.random() * (hi - lo);
      this.phaseDur = Infinity;
    } else {
      this.phaseDur = this.clipSeconds(this.phaseClip) * this.phaseLoops;
      this.deadline = 0;
    }
    if (this.mode === 'walk') {
      // 抄自 _build_walking：均匀随机角，纵向压到 0.35，再归一化
      const ang = (Math.random() * 2 - 1) * Math.PI;
      const vx = Math.cos(ang);
      const vy = Math.sin(ang) * 0.35;
      const len = Math.hypot(vx, vy) || 1;
      this.dir = { x: vx / len, y: vy / len };
    }
  }

  update(dt) {
    this.clock += dt;
    this.phaseTime += dt;
    const speed = this.t.speed || {};
    const p = this.probe;
    if (this.mode === 'walk') {
      const v = Number(speed.walk || 58) * this.speedMul;
      this.pet.moveBy(this.dir.x * v * dt, this.dir.y * v * dt);
      if (p && p.ww) {
        const left = p.wx;
        const right = p.wx + p.ww;
        if (left <= 2 || right >= (p.screenW || 99999) - 2) {
          this.dir.x *= -1;
          this.dir.y = Math.random() * 0.7 - 0.35;
        }
      }
      this.stage.setFlip(this.dir.x < 0);
    } else if (this.mode === 'chase' || this.mode === 'surisuri') {
      if (p && p.ww) {
        const cxp = p.wx + p.ww / 2;
        const cyp = p.wy + p.wh / 2;
        const dx = p.cx - cxp;
        const dy = p.cy - cyp;
        const dist = Math.hypot(dx, dy) || 1;
        this.stage.setFlip(dx < 0);
        const contact = Number(this.t.contactRadius || 10);
        if (this.mode === 'chase' && dist <= contact && this.t.states.surisuri) {
          this.enter('surisuri', 'cursor contact');
          return;
        }
        const v = Number(this.mode === 'chase' ? (speed.chase || 115) : (speed.surisuri || speed.chase || 115));
        const step = Math.min(v * dt, dist);
        this.pet.moveBy((dx / dist) * step, (dy / dist) * step);
      }
    }
    // 无限相位（loops:-1）靠 duration 超时结束。这个判断必须对所有模式生效：
    // 早先写在 walk 分支里，导致「不移动的无限相位」（例如 Spine 干员的 idle）永远不结束。
    if (this.deadline && this.clock >= this.deadline) { this._next(); return; }
    if (this.phaseDur !== Infinity && this.phaseTime >= this.phaseDur) this._next();
  }
}
