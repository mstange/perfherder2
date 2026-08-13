// The one tooltip on screen, as a reactive singleton.
//
// A singleton for the same reason the theme is one: the two halves have no props
// relationship. A hit test deep inside ScatterChart asks for a tooltip and the
// box is drawn by [Tooltip.svelte](Tooltip.svelte), mounted once in App.svelte.
// Threading that down would mean every component between them forwarding a prop
// it doesn't use, and two tooltips could then be open at once.
//
// **This is for things painted into a canvas only.** Ordinary controls use
// `title`, which is why there is no attachment or action here to give an element
// a tooltip — see docs/design.md, "Tooltips: for what the canvas paints".
//
// See [tooltip.ts](tooltip.ts) for the placement rule.

import { contentKey, type Anchor, type TooltipContent } from './tooltip';

// How long the pointer has to rest before a tooltip opens. The marks sit in two
// narrow bands across the plot, so a pointer crossing one band passes several of
// them; opening instantly would flicker a box per mark on the way past.
export const TOOLTIP_DELAY_MS = 350;
// …and how long after one closes that the next opens instantly. Scanning along a
// row of change bars leaves and re-enters the band between bars, and paying the
// delay at every stop reads as the tooltip being slow rather than as it being
// polite.
export const TOOLTIP_WARM_MS = 300;

// Anything can be an owner; identity is all that's used. One object per chart
// instance, so the overview and the detail graph can't close each other's box.
type Owner = object;

type Pending = { owner: Owner; content: TooltipContent; anchor: Anchor };

// Exported for its test only; everything else uses the `tooltip` singleton
// below, and a second live instance would mean two boxes on screen.
export class TooltipController {
  #owner: Owner | null = null;
  // `$state.raw`, not `$state`: both are replaced wholesale and never mutated in
  // place, and a deep proxy would mean the object a caller handed in is not the
  // object Tooltip.svelte reads — which the identity check in `#commit` depends
  // on. Same reasoning as the caches in graphs.md, at a smaller scale.
  #content = $state.raw<TooltipContent | null>(null);
  #anchor = $state.raw<Anchor | null>(null);
  #key = $state<string | null>(null);

  // Not `$state`: nothing renders from these, they only decide whether the next
  // `show` waits.
  #pending: Pending | null = null;
  #openTimer: ReturnType<typeof setTimeout> | null = null;
  #warm = false;
  #warmTimer: ReturnType<typeof setTimeout> | null = null;

  readonly delayMs: number;
  readonly warmMs: number;

  constructor(delayMs = TOOLTIP_DELAY_MS, warmMs = TOOLTIP_WARM_MS) {
    this.delayMs = delayMs;
    this.warmMs = warmMs;
  }

  get content(): TooltipContent | null {
    return this.#content;
  }

  get anchor(): Anchor | null {
    return this.#anchor;
  }

  // Identity of the content, for Tooltip.svelte's measurement. Separate from
  // `content` so that a pointer moving inside one mark doesn't invalidate a
  // measurement that is still good.
  get key(): string | null {
    return this.#key;
  }

  get visible(): boolean {
    return this.#content !== null;
  }

  // Open a tooltip, **or move the open one**. The caller calls this on every
  // pointer move with the same content and a new anchor, which is what "follows
  // the cursor" is; there is deliberately no separate `move`, because then a
  // caller could move a tooltip it doesn't own.
  show(owner: Owner, content: TooltipContent, anchor: Anchor): void {
    if (this.visible || this.#warm) {
      this.#commit(owner, content, anchor);
      return;
    }
    this.#pending = { owner, content, anchor };
    this.#openTimer ??= setTimeout(() => {
      this.#openTimer = null;
      const pending = this.#pending;
      this.#pending = null;
      if (pending) this.#commit(pending.owner, pending.content, pending.anchor);
    }, this.delayMs);
  }

  // Close the tooltip **if the caller is the one showing it**. The check is what
  // keeps one chart's `pointerleave` from closing the box the other chart just
  // opened, and what makes it safe for a caller to call `hide` unconditionally
  // when its hit test comes back empty.
  hide(owner: Owner): void {
    if (this.#pending?.owner === owner) {
      this.#pending = null;
      this.#clearOpenTimer();
    }
    if (this.#owner !== owner) return;
    this.#owner = null;
    this.#content = null;
    this.#anchor = null;
    this.#key = null;
    this.#goWarm();
  }

  // Close whatever is open, whoever owns it: Escape, a scroll under the pointer,
  // a click. No warm window — these all mean "not now" rather than "next one,
  // please".
  hideAll(): void {
    this.#pending = null;
    this.#clearOpenTimer();
    this.#clearWarmTimer();
    this.#warm = false;
    this.#owner = null;
    this.#content = null;
    this.#anchor = null;
    this.#key = null;
  }

  #commit(owner: Owner, content: TooltipContent, anchor: Anchor): void {
    this.#clearOpenTimer();
    this.#pending = null;
    this.#clearWarmTimer();
    this.#warm = false;
    this.#owner = owner;
    const key = contentKey(content);
    // Guarded so a pointer moving inside one mark doesn't invalidate the box's
    // measurement — `content` is a new object on every move even when it says
    // the same thing.
    if (key !== this.#key) {
      this.#key = key;
      this.#content = content;
    }
    this.#anchor = anchor;
  }

  #goWarm(): void {
    this.#warm = true;
    this.#clearWarmTimer();
    this.#warmTimer = setTimeout(() => {
      this.#warmTimer = null;
      this.#warm = false;
    }, this.warmMs);
  }

  #clearOpenTimer(): void {
    if (this.#openTimer !== null) clearTimeout(this.#openTimer);
    this.#openTimer = null;
  }

  #clearWarmTimer(): void {
    if (this.#warmTimer !== null) clearTimeout(this.#warmTimer);
    this.#warmTimer = null;
  }
}

export const tooltip = new TooltipController();
