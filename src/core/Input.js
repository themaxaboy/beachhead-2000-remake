const KEY_ACTIONS = {
  Space: 'toggle',
  KeyM: 'missile',
  KeyG: 'pistol',
  KeyH: 'howitzer',
  Digit1: 'w1',
  Digit2: 'w2',
  Digit3: 'w3',
  Digit4: 'w4',
  Digit5: 'w5',
  Numpad1: 'w1',
  Numpad2: 'w2',
  Numpad3: 'w3',
  Numpad4: 'w4',
  Numpad5: 'w5',
  KeyR: 'reload',
  Equal: 'sensUp',
  NumpadAdd: 'sensUp',
  Minus: 'sensDown',
  NumpadSubtract: 'sensDown',
  Escape: 'pause',
  KeyP: 'pause',
};

/** Mouse (pointer lock) + keyboard input. */
export class Input {
  constructor(canvas, { noLock = false } = {}) {
    this.canvas = canvas;
    this.noLock = noLock;
    this.dx = 0;
    this.dy = 0;
    this.fire = false;
    this.locked = false;
    this.enabled = false; // only true while playing
    this.onAction = () => {};
    this.onLockChange = () => {};
    this.dragging = false;

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.fire = false;
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.onLockChange(false, true);
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || (this.noLock && this.dragging)) {
        this.dx += e.movementX || 0;
        this.dy += e.movementY || 0;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 0) {
        this.fire = true;
        if (this.noLock) this.dragging = true;
      } else if (e.button === 2) {
        this.onAction('toggle');
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.fire = false;
        this.dragging = false;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.onAction(e.deltaY > 0 ? 'next' : 'prev');
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      const action = KEY_ACTIONS[e.code] || (e.key === '+' ? 'sensUp' : e.key === '-' ? 'sensDown' : null);
      if (!action) return;
      if (action === 'pause' || this.enabled) {
        if (e.code === 'Space') e.preventDefault();
        if (!e.repeat) this.onAction(action);
      }
    });
    window.addEventListener('blur', () => {
      this.fire = false;
      this.onAction('blur');
    });
  }

  async requestLock() {
    if (this.noLock) {
      this.locked = true;
      this.onLockChange(true);
      return;
    }
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
    } catch (err) {
      try {
        await this.canvas.requestPointerLock();
      } catch {
        this.onLockChange(false, true);
      }
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.noLock) this.locked = false;
  }

  consumeLook() {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }
}
