import { TermuxControl } from './termuxControl.js';
import { KeritControl } from './keritControl.js';

/**
 * Chooses the one explicitly supported host-control implementation. This keeps
 * the WhatsApp command plugin host-neutral while Termux and Kerit retain their
 * distinct, safe restart semantics.
 */
export class HostControl {
  constructor({ root, logger, env = process.env, termux = null, kerit = null }) {
    this.termux = termux || new TermuxControl({ root, logger, env });
    this.kerit = kerit || new KeritControl({ root, logger, env });
  }

  #active() {
    const termux = this.termux.availability();
    if (termux.ok) return { control: this.termux, availability: termux };
    const kerit = this.kerit.availability();
    if (kerit.ok) return { control: this.kerit, availability: kerit };
    return {
      control: null,
      availability: {
        ok: false,
        reason: `${kerit.reason} Termux alternative: ${termux.reason}`,
      },
    };
  }

  availability() {
    return this.#active().availability;
  }

  async check() {
    const active = this.#active();
    return active.control ? active.control.check() : active.availability;
  }

  async update() {
    const active = this.#active();
    return active.control ? active.control.update() : active.availability;
  }

  scheduleRestart(delayMs) {
    const active = this.#active();
    return active.control ? active.control.scheduleRestart(delayMs) : active.availability;
  }
}

export default HostControl;
