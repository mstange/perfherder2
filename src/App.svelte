<script lang="ts">
  // Three-pane shell: series list, graphs, selection details. The Add-series
  // picker opens as an overlay over the lot — it needs the full width for its
  // table, and mounting it lazily keeps its multi-megabyte signature fetch off
  // the critical path for someone opening a shared graph link.

  import { fade, fly } from 'svelte/transition';

  import AddSeriesPicker from './lib/picker/AddSeriesPicker.svelte';
  import DetailsPane from './lib/graphs/DetailsPane.svelte';
  import GraphPane from './lib/graphs/GraphPane.svelte';
  import SeriesList from './lib/graphs/SeriesList.svelte';
  import ChevronIcon from './lib/shared/ChevronIcon.svelte';
  import ThemeToggle from './lib/shared/ThemeToggle.svelte';
  import Tooltip from './lib/shared/Tooltip.svelte';
  import { AppState } from './lib/graphs/appState.svelte';
  import {
    PANE_LABELS,
    isPaneVisible,
    layoutFor,
    listIsSheet,
    listSheetCoversPanes,
    resolvePane,
    switchedPanes,
    type Pane,
  } from './lib/shared/layout';
  import type { Series } from './lib/picker/series';

  const app = new AppState(location.search);

  // Both take effect immediately and leave the panel open. The picker used to
  // stage adds and close on commit; it no longer stages anything, so there is
  // nothing left for closing to mean. Each call is one `syncUrl('push')`, so
  // Back undoes exactly one click — including a bulk one, which is why these
  // hand the whole array down rather than looping.
  const refFor = (s: Series) => ({
    repository: s.repository,
    signatureId: s.id,
    frameworkId: s.frameworkId,
  });

  function handleAdd(series: Series[]) {
    app.addSeries(series.map(refFor));
  }

  function handleRemove(series: Series[]) {
    app.removeSeries(series.map(refFor));
  }

  // Which of the four arrangements the window can afford. The thresholds and
  // the reasoning are in layout.ts; what is here is only the wiring.
  //
  // Driven from JS and published as `data-layout` rather than written as media
  // queries, because two things that are not CSS have to agree with it: which
  // panes the Add-series panel covers (and therefore which are `inert` while it
  // is open — a DOM property no media query can set), and which panes the
  // switcher offers. A media query plus a matching `matchMedia` would be the
  // same numbers written twice, and the failure would be silent.
  //
  // Both axes, because one arrangement puts a pane in a *row*, and a row needs
  // height the way a column needs width — see layout.ts. `resize` fires for either
  // dimension, so one listener covers both.
  let layout = $state(layoutFor(window.innerWidth, window.innerHeight));
  $effect(() => {
    const measure = () => (layout = layoutFor(window.innerWidth, window.innerHeight));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  // The height the app lays itself out in, when that is not the window's.
  //
  // `100dvh` is the window, and the window is not what an on-screen keyboard
  // takes space from: iOS leaves the layout viewport alone and slides a smaller
  // *visual* viewport around inside it, so a full-height shell keeps its full
  // height and the keyboard simply covers the bottom of it — which, with the
  // Add-series panel open, is the list the panel exists to show. Measured on a
  // 390×844 viewport: a 336px keyboard left the picker's list 2px tall.
  // `interactive-widget` in index.html asks the browser to do this for us and
  // Chrome obliges; this is for the ones that don't.
  //
  // **Gated on the scale, because pinch-zoom shrinks the visual viewport too.**
  // Zooming in on a graph would otherwise re-lay-out the app to the magnified
  // region, which is a rearrangement nobody asked for. A keyboard leaves the
  // scale at 1, so that is the tell.
  let appHeight = $state<number | null>(null);
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => {
      appHeight = vv.scale > 1.01 ? null : Math.round(vv.height);
    };
    measure();
    vv.addEventListener('resize', measure);
    return () => vv.removeEventListener('resize', measure);
  });
  const heightStyle = $derived(appHeight === null ? null : `${appHeight}px`);

  // The panes sharing one cell in this arrangement, and which of them has it.
  // Deliberately not in the URL — it answers "what am I looking at on this
  // screen", not "what am I looking at", and a shared link that forced a
  // companion onto the Selection tab because the sender was on a phone would be
  // a bug.
  const panes = $derived(switchedPanes(layout));
  let requestedPane = $state<Pane>('graph');
  const activePane = $derived(resolvePane(requestedPane, panes));

  // The series list, where it is a sheet rather than a column: one button in the
  // bottom bar reveals it, and that same button dismisses it again — as do its
  // own close button, Escape, and a tap on the dimmed strip of graph it leaves
  // showing. See docs/design.md, "The sheet rises from the handle and leaves it
  // on screen".
  //
  // Local, and not in the URL, for the reason `requestedPane` is: it is a fact
  // about this screen. Reset when the arrangement gives the list a column back,
  // or a resize would leave a sheet's worth of `display: none` sitting over a
  // layout that has nowhere to put it.
  const sheeted = $derived(listIsSheet(layout));
  let listSheetOpen = $state(false);
  // Hoisted rather than inlined in the markup, so the prop's identity changes only
  // when `sheeted` does. Nothing downstream is keyed on it today; a fresh arrow per
  // render is a prop that reads as changed on every update, which is the kind of
  // thing that is free to fix now and awkward to find later.
  const closeSheet = () => (listSheetOpen = false);
  $effect(() => {
    if (!sheeted) listSheetOpen = false;
  });

  // Is this a bottom sheet over both panes, or the 280px drawer that leaves the
  // graph beside it? A question about the arrangement, not about whether the sheet
  // is open, because the scrim and the peek have to exist in the DOM while it is
  // closed too — that is what gives them something to animate *from*.
  const bottomSheet = $derived(listSheetCoversPanes(layout));
  // And the same question about the sheet as it stands. Only a bottom sheet has to
  // take what it hides out of the DOM: it is on top of both panes, so Tab would
  // otherwise walk into controls nobody can see. `z-index` is a paint order and
  // cannot say that, which is why this is a property and not CSS.
  //
  // **The bar is not among them any more**, in either presentation: the sheet stops
  // at the bar's top edge and slides away behind it, so the handle that opened it
  // stays on screen, keeps its chevron pointed at where the sheet went, and is the
  // control that brings it back. See docs/design.md.
  //
  // A drawer leaves everything it overlaps visible, so nothing there is hidden and
  // nothing needs to be inert; it is non-modal in the same way, and for the same
  // reason, as the Add-series panel docked beside this list in `wide`.
  const sheetCovers = $derived(listSheetOpen && bottomSheet);
  // Open in either presentation. What the slot announces itself as, and what the
  // focus round trip below is keyed on — a drawer is just as much a revealed region
  // as a full-window sheet, it simply hides nothing while it is there.
  const sheetShown = $derived(sheeted && listSheetOpen);

  // And focus, which `inert` would otherwise drop on the floor: blurring the
  // element it is applied to sends focus to the body, so a keyboard user opening
  // the sheet would land back at the top of the document and Tab their way in.
  //
  // **The sheet's own *slot* takes the focus, not a control inside it.** The slot
  // is the shell's element, so this needs no prop threaded through SeriesList and
  // no `:global` reach for a class name in another file — and a `tabindex="-1"`
  // container is the right target anyway: Tab from there walks the sheet's
  // controls in their own order rather than starting from whichever one the shell
  // decided to pick. `tabindex="-1"` is unconditional — it takes nothing into the
  // tab order, so it costs the three column arrangements nothing — while the
  // `dialog` role and its label are not, because in those three the slot is an
  // ordinary grid cell and calling it a dialog would be a lie to a screen reader.
  //
  // Coming back is the panel's `restoreFocusTo` pattern below, and simpler:
  // exactly one control opens this, so the handle *is* where focus came from.
  let handleEl = $state<HTMLButtonElement | null>(null);
  let sheetEl = $state<HTMLElement | null>(null);
  let sheetWasOpen = false;
  $effect(() => {
    if (listSheetOpen === sheetWasOpen) return;
    sheetWasOpen = listSheetOpen;
    const target = listSheetOpen ? () => sheetEl : () => handleEl;
    // After the DOM settles: on open the slot is still `display: none`, and on
    // close the handle is still `inert` — neither takes focus in that state.
    queueMicrotask(() => target()?.focus());
  });

  // A click on the graph *is* a request to see the selection, and where the
  // selection is switched it is a pane the user would otherwise have to go and
  // find. Only on a change of point, so that zooming, hiding a series or
  // toggling a switch — all of which touch the selection without being about it
  // — leave the user where they are.
  //
  // **And the reverse, which used to be `resolvePane`'s job.** A selection can go
  // away without the user asking — removing the last series, a Back that drops
  // the point — and leaving the switcher pressed on a pane that now only says
  // "tap a point" is not what they were reading. Moving it *here*, at the moment
  // the point goes, is what lets a deliberate tap on Selection with nothing
  // selected show the pane and its instruction instead of being swallowed. See
  // `resolvePane`.
  let lastSelected: unknown = app.selectedPoint;
  $effect(() => {
    const selected = app.selectedPoint;
    if (selected !== lastSelected) {
      lastSelected = selected;
      if (selected) {
        if (panes.includes('selection')) requestedPane = 'selection';
      } else if (requestedPane === 'selection') {
        requestedPane = 'graph';
      }
    }
  });

  // The panel covers the graph and the details pane in every arrangement. It
  // covers the series list only when the list isn't beside it — which is where
  // the list is a sheet, and there the panel has the whole window. See
  // docs/design.md, "The Add-series panel docks beside the series list".
  const listCovered = $derived(app.pickerOpen && sheeted);

  // The bottom bar's series button: how many, and in what colors. The dots are a
  // count cue rather than a legend — they say "these lines are what you are
  // looking at", and the swatch that identifies a series by *shape* as well as
  // color is in the list this button opens. Four is where they stop being
  // countable at a glance, and the number beside them is the real answer anyway.
  const MAX_DOTS = 4;
  const seriesDots = $derived(app.series.slice(0, MAX_DOTS).map((e) => e.color));
  const seriesCount = $derived(app.series.length);

  // How long the Add-series panel takes to arrive and to leave, and the panel is
  // the only thing here that needs the number in JS: it is mounted by an `{#if}`,
  // so its exit has to be a Svelte transition rather than CSS — an element that
  // has already been removed cannot transition out. The series sheet is only ever
  // shown and hidden, never mounted and unmounted, so it animates in the style
  // block below with no JS at all and reads `prefers-reduced-motion` the ordinary
  // way. Same duration in both places; it is written twice because the two
  // mechanisms cannot share it, so keep them in step.
  const MOTION_MS = 220;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = $state(reduceMotion.matches);
  $effect(() => {
    const measure = () => (reduced = reduceMotion.matches);
    measure();
    reduceMotion.addEventListener('change', measure);
    return () => reduceMotion.removeEventListener('change', measure);
  });
  const motionMs = $derived(reduced ? 0 : MOTION_MS);

  // Send focus back where it came from when the panel closes, so dismissing
  // it doesn't dump the user at the top of the document.
  //
  // `$effect.pre` matters: it runs *before* the DOM update that mounts the
  // picker, so `activeElement` is still the button that opened it. A plain
  // `$effect` would run after the picker's autofocused input had already
  // taken focus, and we'd memorize an element that is about to be destroyed.
  let restoreFocusTo: HTMLElement | null = null;
  $effect.pre(() => {
    if (app.pickerOpen) {
      restoreFocusTo = document.activeElement as HTMLElement | null;
    } else if (restoreFocusTo) {
      const target = restoreFocusTo;
      restoreFocusTo = null;
      // After the DOM settles, or focus lands on the element being removed.
      queueMicrotask(() => target.focus());
    }
  });
</script>

<!-- Escape closes the series sheet, the same exit the Add-series panel gives.
     Not registered conditionally: the handler is a no-op unless the sheet is
     open, and a listener whose lifecycle follows a boolean is a listener to get
     wrong. -->
<svelte:window
  onpopstate={() => app.onPopState(location.search)}
  onkeydown={(e) => {
    if (e.key === 'Escape' && listSheetOpen && !app.pickerOpen) listSheetOpen = false;
  }}
/>

<!-- Declarative rather than an `$effect` writing `document.title`: Svelte
     already owns this element, and the title is a plain function of the state.
     index.html carries a static fallback for the pre-hydration moment. -->
<svelte:head>
  <title>{app.pageTitle}</title>
</svelte:head>

<!-- One slot per pane, and the slot is the grid item. The panes are components
     with scoped styles, so the shell cannot place them directly without
     reaching through `:global` for their class names — which would make every
     rearrangement here depend on a class name three files away. The slot is
     also where `inert` goes: it is a DOM-tree property and grid placement is a
     layout one, and giving each pane its own box lets the two be set
     independently, which is what the narrow case needs. -->
<main
  data-layout={layout}
  data-pane={panes.length > 0 ? activePane : null}
  data-plotted={seriesCount > 0 || null}
  style:height={heightStyle}
>
  <!-- The app's own chrome, in the bottom-left corner at every width. It holds up
       to three things: the button that opens the series sheet, the switcher for
       panes that can't be beside each other here, and the theme toggle — which is
       the one always present, and the reason the bar is.

       **It spans one column, not the window.** Under the series list in `wide` and
       under the graph in `medium`, so in both the details pane keeps its full
       height: it is a column of a pane whose content runs past 1000px, and a bar
       across the bottom would cost it 45px to say nothing about it. A bar spanning
       the window also cost the graph that height in `wide` for one toggle, which is
       what made the toggle end up smuggled into the series list's footer in the
       first place — where it was app chrome reachable only by opening a data
       control. At one column there is only one column to be under.

       One element rather than three grid items because in `narrow-short` all three
       are present and all belong at the bottom edge, and items sharing a grid area
       stack on top of each other.

       **Live while the series sheet is open**, which is the whole point of the
       sheet stopping at its top edge: the handle stays put and tapping it again is
       the shortest way back, so the bar cannot be `inert` the way the panes are.
       Only the Add-series panel, which does cover it, takes it out. -->
  <div class="bar" inert={listCovered}>
    {#if sheeted}
      <!-- The series list, demoted to a button that states its count. This is
           the trade every arrangement below `wide` makes: the list is opened
           once a session, where the graph is read continuously and the selection
           once per point, so those two keep their columns and the list gets
           this. See layout.ts.

           Full-width in `narrow` only, where the bar is a phone wide and holds
           nothing else: there it is a sheet handle and reads as one. Aria says
           `expanded`/`controls` rather than `haspopup`: the sheet is a region in
           this document that this button reveals, which is what those two
           describe. -->
      <button
        type="button"
        bind:this={handleEl}
        class="btn list-handle"
        aria-expanded={listSheetOpen}
        aria-controls="series-sheet"
        onclick={() => (listSheetOpen = !listSheetOpen)}
      >
        {#if seriesDots.length > 0}
          <span class="dots" aria-hidden="true">
            {#each seriesDots as color, i (i)}<span class="dot" style:background={color}
              ></span>{/each}
          </span>
        {/if}
        <span class="count">{seriesCount === 0 ? 'No series' : `${seriesCount} series`}</span>
        <ChevronIcon dir={listSheetOpen ? 'down' : 'up'} />
      </button>
    {/if}
    {#if panes.length > 0}
      <!-- Some panes can't be beside each other here, so they take turns and this
           says whose turn it is. A segmented group because it is an exclusive
           choice — the same vocabulary as the graph header's tracks; see
           docs/graphs.md, "The header is two groups". Its contents come from
           `switchedPanes`, which never offers the series list: that is the sheet's
           job now, and the one arrangement that switches anything switches exactly
           the graph and the selection. -->
      <nav class="switcher" aria-label="Pane">
        <div class="btn-group" role="group">
          {#each panes as pane (pane)}
            <button
              type="button"
              class="btn"
              class:btn-selected={activePane === pane}
              aria-pressed={activePane === pane}
              onclick={() => (requestedPane = pane)}
            >
              {PANE_LABELS[pane]}
            </button>
          {/each}
        </div>
      </nav>
    {/if}
    <!-- An appearance preference, not a data control, which is why it is here and
         not in a pane: this bar is the only chrome that belongs to the app rather
         than to something the app is showing. Trailing edge, and last in the DOM,
         so it is the last thing Tab reaches rather than sitting between the
         navigation and the panes. -->
    <ThemeToggle />
  </div>

  {#if bottomSheet}
    <!-- The dim over the strip of graph the bottom sheet leaves showing, and the
         fourth way out of it. Its job is the hierarchy the sheet had no way to
         state when it took the whole window: something is still back there, this is
         on top of it, and it is out of play until you come back.

         Rendered whenever the arrangement is a bottom sheet rather than whenever
         one is open, so it has a previous state to fade from and to — see the
         style block. Both panes are already `inert` behind it, so this adds no
         keyboard trap of its own; it also adds no keyboard *exit*, which is why
         it is a plain div and not a button. Escape, the handle and the header's
         cross are the three that a keyboard has, and a fourth tab stop in front of
         the sheet's own contents would cost more than it gives. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="scrim" data-active={listSheetOpen || null} onclick={closeSheet}></div>
  {/if}

  <!-- The series list stays live while the panel is open — it's the only place
       the result of an Add or a Remove is visible, and it's the control the
       user will keep using once the panel closes. See docs/design.md, "The
       Add-series panel docks beside the series list". At the one-column widths
       there is no beside, so there it is covered like the rest.

       `data-active` is what every slot uses to say it is on screen, and for this
       one it means two different things by arrangement: a column is always on
       screen, a sheet only while it is open. `onclose` is also what tells the
       list it is a sheet — it renders a close button only when there is
       somewhere for closing to go. -->
  <div
    bind:this={sheetEl}
    class="slot slot-list"
    id="series-sheet"
    data-active={(sheeted ? listSheetOpen : true) || null}
    inert={listCovered}
    tabindex="-1"
    role={sheetShown ? 'dialog' : null}
    aria-label={sheetShown ? 'Series' : null}
  >
    <SeriesList {app} onclose={sheeted ? closeSheet : undefined} />
  </div>
  <div
    class="slot slot-graph"
    data-active={isPaneVisible('graph', activePane, panes) || null}
    inert={app.pickerOpen || sheetCovers}
  >
    <GraphPane {app} />
  </div>
  <div
    class="slot slot-details"
    data-active={isPaneVisible('selection', activePane, panes) || null}
    inert={app.pickerOpen || sheetCovers}
  >
    <DetailsPane {app} />
  </div>
</main>

{#if app.pickerOpen}
  <!-- Not `aria-modal`, and no click-to-dismiss: with the series list live
       beside it this is a non-modal panel, and a stray click near its edge
       closing it would be a trap rather than an escape hatch. Done, the close
       button and Escape are the ways out. The dim is still here — it's what
       says the graph behind is out of play while the list beside it isn't. -->
  <!-- `data-full` rather than the tier: what decides whether the panel docks past
       the series list or takes the window is whether the list is *there*, which is
       one question (`listIsSheet`) and two tiers. Naming the tiers here would be
       the third place that list has to be kept in step. -->
  <!-- Two transitions rather than one, because the backdrop and the panel are
       saying different things: the dim is the graph going out of play, and it only
       ever fades, while the panel is the thing that arrives from somewhere. Where
       it takes the window it rises from the bottom edge — the same motion as the
       series sheet under it, from the same direction, because at that width it is
       summoned from the same corner. Docked in `wide` it has nowhere to rise from,
       so it fades with its backdrop and stays put.

       `opacity: 1` on the fly: the backdrop's fade is already the panel's fade, and
       two of them compound into a panel that is 25% opaque halfway through. -->
  <div
    class="overlay"
    data-full={sheeted || null}
    style:height={heightStyle}
    transition:fade={{ duration: motionMs }}
  >
    <div
      class="overlay-panel"
      role="dialog"
      aria-label="Add series"
      transition:fly={{ y: sheeted ? '100%' : 0, opacity: 1, duration: motionMs }}
    >
      <AddSeriesPicker
        onadd={handleAdd}
        onremove={handleRemove}
        onclose={() => app.setPickerOpen(false)}
        initialView={app.pickerView}
        graphContext={app.graphContext}
        plotted={app.plottedColors}
        onviewchange={(v) => app.setPickerView(v)}
      />
    </div>
  </div>
{/if}

<!-- One box for the whole app, positioned from the pointer. Last, and outside
     both the grid and the overlay: it is fixed and above everything, and it must
     not be inside the `inert` wrapper — a tooltip describing the graph behind the
     panel is still worth reading. See docs/design.md, "Tooltips". -->
<Tooltip />

<style>
  main {
    /* How long the series sheet and its scrim take to arrive and to leave.
       Mirrors `MOTION_MS` above, which the Add-series panel's Svelte transitions
       read: the two mechanisms cannot share a number, so this is the copy CSS can
       see. Here rather than at `:root` because it is this shell's motion and
       app.css has no other use for it. */
    --sheet-motion: 220ms;
    display: grid;
    height: 100vh;
    height: 100dvh;
    /* The notch, the rounded corners and the home indicator. In landscape on a
       phone the plot would otherwise run under the camera housing, and the
       bottom bar under the gesture bar. `env()` resolves to 0 where
       there is no inset and on every browser that doesn't know it, so this costs
       nothing anywhere else — and `border-box` is what keeps the padding inside
       the 100dvh rather than adding to it. */
    box-sizing: border-box;
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
      env(safe-area-inset-bottom) env(safe-area-inset-left);
    overflow: hidden;
    background: var(--bg-canvas);
    color: var(--fg-default);
  }
  /* A grid rather than a block so the pane inside stretches to the slot in both
     axes without the shell naming it. `min-*: 0` because the panes are flex
     columns ending in a scroller, and an `auto` minimum anywhere in that chain
     is what makes a pane size to its content and push the scrollbar off the
     bottom of the window instead of scrolling. */
  .slot {
    display: grid;
    min-width: 0;
    min-height: 0;
  }

  /* Three columns. Fixed side panes, elastic middle: the graph absorbs every
     extra pixel, and the panes must not resize as their content loads.

     The bar takes a second row under the *list* only, so the graph and the details
     pane both run the full height of the window. That is the same 45px in the same
     corner the series list's own footer used to spend, so this arrangement is
     unchanged on screen — what changed is which element owns it. */
  main[data-layout='wide'] {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--details-width);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'list graph details'
      'bar graph details';
  }

  /* Two columns, and the one that goes is the series list: `graph │ selection`,
     both full height, with the list behind the bar's button. An iPad in landscape,
     a tiled half-screen window, a landscape phone.

     **This replaced two tiers, and both were paying for the list's column out of
     the graph's height.** `medium` used to keep `list │ graph` and put the details
     pane in a *row* under the graph; `short` sat below it for windows with no
     height for that row, where the details pane took turns with the graph in a
     switcher — which is the arrangement where you could only ever see one of the
     two things the app is for. A column costs its width once and a row costs 40%
     of the height forever, so at a 900px window the old arrangement left the graph
     620×432 and this one leaves it 580×843: 34% more plot for 40px less width, and
     the same answer at every width in the band.

     The old boundary between them also ran backwards. At 900×716 `short` gave the
     graph 620×655, and four more pixels of window height tipped it into `medium`
     and 620×432 — a window growing made the graph a third smaller. With nothing in
     a row here, height has no say at this tier at all, which is what makes the old
     `short` unnecessary rather than merely improved: it existed because a row needs
     height the way a column needs width.

     Height therefore gets the same answer it gets in `wide`: a short window makes
     every column short, and no rearrangement helps. See layout.ts.

     The bar sits under the graph rather than across the window, so the details
     pane keeps its full height. The pane's content runs past 1000px, so those 45px
     are worth more to it than to a bar that says nothing about it — and the bar's
     contents are one button and a toggle, which fit in 440px at the tightest window
     this tier covers. */
  main[data-layout='medium'] {
    grid-template-columns: minmax(0, 1fr) var(--details-width);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'graph details'
      'bar details';
  }

  /* One column: the details pane's column becomes a row, which is the next-least
     thing to give up after the list's column. Both panes still on screen. A phone
     in portrait.

     This used to be three panes taking turns, which charged the same tap for
     "what did I just select" and "what is plotted" — and made the first one cost
     a round trip on every point the reader looked at.

     The row takes 45% where there is 45% to spare and *everything above the
     graph's floor* where there isn't — `100% - 382px`, being the graph's
     collapsed-header minimum plus the bar. Not a fixed cap: a cap protects the
     graph on a tall window and does nothing on a short one, and it is the short one
     that needs protecting here. Both numbers are mirrored in layout.ts
     (`NARROW_DETAILS_ROW_FRACTION`, `NARROW_GRAPH_RESERVE`), which computes this
     tier's threshold from them; a copy that drifts is a threshold that has stopped
     meaning what it says. */
  main[data-layout='narrow'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) min(45%, calc(100% - 382px)) auto;
    grid-template-areas:
      'graph'
      'details'
      'bar';
  }
  /* With nothing plotted the details row would be a second empty state under the
     graph's own — "tap a point in the graph" in 380px, below "Nothing plotted
     yet" in 400. So it goes, and the graph takes the window: the same reasoning
     that makes the graph pane a call to action rather than a pair of empty axes
     (graphs.md, "With nothing plotted, the pane is a call to action").

     **This is a layout change that reserving space is supposed to prevent, and
     it is allowed because of where the user is when it happens.** Every path
     between nothing plotted and something plotted runs through the Add-series
     panel or the series sheet, and at this width both of those cover the whole
     window — so the row appears and disappears behind something opaque, never
     under a thumb that was about to tap a point. The bar stays either way, which
     is what keeps the one piece of chrome that is always tappable from moving. */
  main[data-layout='narrow']:not([data-plotted]) {
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'graph'
      'bar';
  }
  main[data-layout='narrow']:not([data-plotted]) > .slot-details {
    display: none;
  }

  /* One column with no height to stack in: the graph and the details pane go back
     to taking turns, which makes this the only arrangement left that switches
     anything at one column. A window dragged small in both axes, and a phone with
     the keyboard up. The list is a sheet here too — a window this size has even
     less to spare for a pane read once a session — so the bar holds both its
     button and the switcher. */
  main[data-layout='narrow-short'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'pane'
      'bar';
  }
  main[data-layout='narrow-short'] > .slot-graph,
  main[data-layout='narrow-short'] > .slot-details {
    grid-area: pane;
  }
  /* The handle spans the bar in the one arrangement where the bar is a phone wide
     and holds nothing else, because there it is a sheet handle and is meant to read
     as one — chevron at the far edge, count beside its dots. Everywhere else it
     sizes to its content: beside the switcher in `narrow-short` there is no room to
     spare, and in `medium` the bar is 760–1039px and a button that wide is not a
     handle, it is a mistake. After the base rule, since neither a class nor an
     attribute selector here adds enough specificity to reorder safely. */
  main[data-layout='narrow'] > .bar > .list-handle {
    flex: 1;
  }
  main[data-layout='narrow'] > .bar > .list-handle > .count {
    margin-right: auto;
  }
  /* The sheet, in both presentations. It carries its own background because it is
     the only slot with something behind it. `border-right` is drawn here rather
     than by `.slot-list`'s seam rule below, because in `wide` that edge faces the
     graph and here it faces the graph *over* it — same line, different job, and the
     shadow beside it is what says which.

     **`1 / -2`, so it stops at the bar rather than covering it.** It used to span
     every row including the bar that opened it, which hid the handle behind the
     thing the handle had just revealed — along with the chevron that flips to point
     the way the sheet moves, so the one affordance saying "tap this again" was
     never once on screen. Leaving the bar out gives the sheet a fixed edge to rise
     from and settle back into, and makes summoning and dismissing the same tap in
     the same place. See docs/design.md, "The sheet rises from the handle and leaves
     it on screen". */
  main:not([data-layout='wide']) > .slot-list {
    grid-column: 1;
    grid-row: 1 / -2;
    z-index: 5;
    background: var(--bg-canvas);
  }
  /* The slot takes focus when the sheet opens (see `sheetEl`), and a UA focus ring
     around a whole pane reads as a rendering fault rather than as "you are here" —
     it is a 280px-wide blue box drawn over the pane's own border and shadow. The
     ring is suppressed rather than restyled because the *reveal* is the indication:
     the sheet was not there a moment ago. Every control inside it keeps its own
     `:focus-visible`, which is what a keyboard user actually navigates by. */
  main:not([data-layout='wide']) > .slot-list:focus {
    outline: none;
  }
  /* Two columns: a drawer the width of the column the list has in `wide`, in the
     same place, so it reads as that column coming back rather than as a new screen.
     Sized to the window instead — the first version — it is three cards and a
     header stretched across 1039px. Nothing behind it is hidden, so nothing behind
     it is `inert` and there is no backdrop: the shadow is what says it is on top.
     See layout.ts, `listSheetCoversWindow`. */
  main[data-layout='medium'] > .slot-list {
    width: var(--sidebar-width);
    border-right: 1px solid var(--border-default);
    box-shadow: var(--shadow-overlay);
  }
  /* The bottom sheet: the one-column presentation, where the list rises over both
     panes from the bar that summons it.
     ---------------------------------------------------------------------------
     Five things say "this is a layer on top of the graph, and it came from down
     there" — and the version before this one had none of them, so the only reading
     left was that the app had navigated to a page. The list's `--bg-subtle` is
     *darker* than the graph's canvas in the light theme, which reads as behind
     rather than above, so the tint cannot carry the elevation on its own here and
     the other four have to. See docs/design.md.

     The peek is the first: the graph is left showing above the sheet, under a dim,
     so there is visibly something to come back to. Derived from what fits in it
     rather than chosen — the graph pane's header collapses to a 41px bar
     (graphs.md, "A pane too small for the bar collapses it to one line"), and in
     `narrow` there is room for that plus a slice of the plot it labels, which is
     what makes it read as a graph and not as a stray toolbar. In `narrow-short`
     every pixel is already spoken for, so it is the header and nothing else. */
  main[data-layout='narrow'] {
    --sheet-peek: 80px;
  }
  main[data-layout='narrow-short'] {
    --sheet-peek: 48px;
  }
  main[data-layout='narrow'] > .slot-list,
  main[data-layout='narrow-short'] > .slot-list {
    margin-top: var(--sheet-peek);
    /* Two and three: a lifted edge, and the shadow it casts on the dim. `overflow`
       because the pane inside draws its own square-cornered header against it. */
    border-radius: 12px 12px 0 0;
    overflow: hidden;
    box-shadow: var(--shadow-overlay);
    /* Four: it arrives from below and leaves the same way, so the handle is
       visibly where it comes from and goes. `display` is in the transition because
       the rule that hides an inactive slot uses `display: none` — one rule for
       every slot, and worth keeping — and a discrete property has to be told to
       wait for the rest of the animation before it takes effect. */
    transition:
      transform var(--sheet-motion) ease,
      display var(--sheet-motion) allow-discrete;
  }
  main[data-layout='narrow'] > .slot-list:not([data-active]),
  main[data-layout='narrow-short'] > .slot-list:not([data-active]) {
    transform: translateY(100%);
  }
  /* The state it animates *from* on the way in. Without this the sheet has no
     previous position — it goes straight from `display: none` to placed — and only
     the exit would move. */
  @starting-style {
    main[data-layout='narrow'] > .slot-list[data-active],
    main[data-layout='narrow-short'] > .slot-list[data-active] {
      transform: translateY(100%);
    }
  }

  /* Five: the dim itself, over the peek. Same rows as the sheet, so it stops at the
     bar too — the bar is the one thing on screen that is never out of play, and
     dimming the control that dismisses the sheet would be saying the opposite. */
  .scrim {
    grid-column: 1 / -1;
    grid-row: 1 / -2;
    z-index: 4;
    background: var(--backdrop);
    transition:
      opacity var(--sheet-motion) ease,
      display var(--sheet-motion) allow-discrete;
  }
  .scrim:not([data-active]) {
    display: none;
    opacity: 0;
  }
  @starting-style {
    .scrim[data-active] {
      opacity: 0;
    }
  }
  /* Nothing here carries information that the movement is the only source of — the
     sheet is opaque and the dim is a colour — so under this preference both simply
     appear. `0s` rather than dropping the transition, so the `allow-discrete`
     handling of `display` stays intact. */
  @media (prefers-reduced-motion: reduce) {
    main {
      --sheet-motion: 0s;
    }
  }

  /* One rule for every arrangement where a slot can be off screen, and it reads
     the slot's own attribute rather than naming panes: what puts a slot off
     screen differs between them — a turn in the switcher for the graph and the
     details pane, a closed sheet for the list — and `data-active` is where the
     shell has already resolved that difference.

     The inactive slots are taken out with `display: none` rather than
     `visibility` or a `hidden` attribute, because it is also what takes them out
     of the tab order and the accessibility tree, and the bar is the only honest
     way to reach them. The charts come back correctly sized: ScatterChart
     observes its wrapper, so 0×0 and back is a resize like any other. */
  main:not([data-layout='wide']) > .slot:not([data-active]) {
    display: none;
  }

  .slot-list {
    grid-area: list;
  }
  .slot-graph {
    grid-area: graph;
  }
  .slot-details {
    grid-area: details;
  }

  /* The seams. They live here, on the slots, rather than on the panes, because
     which of a pane's sides faces another pane is a fact about the arrangement
     and the arrangement changes: the details pane drew its own `border-left`
     until it moved under the graph, where that edge lands against the series
     list's `border-right` and the two render as one 2px rule. A pane cannot
     know that; the shell is the only thing that does. Exactly one rule per
     seam, on the slot above or to the left of it. */
  main[data-layout='wide'] > .slot-list,
  main[data-layout='wide'] > .bar {
    border-right: 1px solid var(--border-default);
  }
  main[data-layout='wide'] > .slot-details,
  main[data-layout='medium'] > .slot-details {
    border-left: 1px solid var(--border-default);
  }
  main[data-layout='narrow'] > .slot-details {
    border-top: 1px solid var(--border-default);
  }
  /* `narrow-short` draws none: one pane fills the column above the bar, so every
     edge it has is the window's own or the bar's. The drawer's own right edge is
     up with the rest of its rules, because there it is not a seam between two
     cells — it is the edge of something lying on top. */

  /* The bar. One box in the bottom-left corner at every width, and the top edge is
     the only rule it draws — it is the bottom of the window everywhere, so there is
     never anything below it to draw a seam against. It is also the app's primary
     navigation on the devices least able to reach the top of their own screen, and
     the bottom is where every touch platform puts one. */
  .bar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-top: 1px solid var(--border-default);
    background: var(--bg-subtle);
    /* Above the sheet (5) and its scrim (4), which is what lets the sheet slide
       away *behind* it: `translateY(100%)` moves the sheet down by exactly its own
       height, and since the sheet stops at this bar's top edge that lands it over
       the bar. A bar that vanished under a departing sheet and blinked back at the
       end of the animation would undo the point of keeping it. Grid items take a
       `z-index` without being positioned. */
    z-index: 6;
  }
  .switcher {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  /* One track across whatever the switcher spans — the rest of the bar in
     `narrow-short`, the graph's column in `short` — with equal segments, so the
     labels don't move as the selected one takes its fill and the targets are as
     big as the width allows. These are the arrangements most likely to be driven
     by a thumb. */
  .switcher .btn-group {
    display: flex;
    flex: 1;
  }
  .switcher .btn {
    flex: 1;
  }

  /* The series sheet's handle. `.btn` for the chrome, plus the three things it
     owns: a row of color dots, the count, and a chevron that points the way the
     sheet moves. It sits at the left of the bar, under where the list's own column
     is in `wide` and where its drawer opens — so the handle and the thing it opens
     share an edge. */
  .list-handle {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .list-handle .count {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dots {
    display: flex;
    /* Overlapped rather than spaced: four dots in a row is a legend, four dots
       stacked like coins is one mark that happens to carry four colors — which is
       what this is, the count beside it being the real answer. */
    margin-right: -3px;
  }
  .dot {
    width: 10px;
    height: 10px;
    margin-right: -3px;
    border-radius: 50%;
    /* Against the bar, so overlapping dots stay countable whichever colors land
       next to each other. */
    box-shadow: 0 0 0 1.5px var(--bg-subtle);
  }
  /* The full 44px on a coarse pointer, rather than app.css's 32px floor: these are
     the app's primary navigation, and the controls most often driven by a thumb at
     the far end of its reach. */
  @media (pointer: coarse) {
    .switcher .btn,
    .list-handle {
      min-height: 44px;
    }
  }
  /* Starts where the series list ends, so the list is neither dimmed nor
     covered. The panel is stretched to exactly the space between the
     backdrop's padding edges — never taller. Everything inside it (see the
     flex chain down to the picker's .table-wrap) shares that fixed budget, so
     the only scrollable element in the panel is the series table itself.
     Nothing here may grow with content, or the overlay starts scrolling as a
     whole and the sticky table header scrolls out of view with it. */
  .overlay {
    position: fixed;
    /* `bottom: auto` and a height, rather than pinning both edges: the height is
       what `appHeight` overrides inline when a keyboard has taken the bottom of
       the window, and an over-constrained box (top + bottom + height) resolves by
       silently dropping one of them. Say which. */
    inset: 0 0 auto var(--sidebar-width);
    height: 100dvh;
    /* Docking to the right of the list only means something while the list is
       a column. At the one-column widths it is a sheet, so the panel takes the
       window — which is what it was before it learned to dock, and the reason
       the list's slot goes `inert` at those widths with it. */
    background: var(--backdrop);
    display: flex;
    align-items: stretch;
    /* Left, not centered: docked against the list it reports into. On a
       display wide enough for the 1400px cap to bite, what's left over is
       graph — dimmed, but visible, and better company than empty backdrop. */
    justify-content: flex-start;
    padding: 16px;
    /* Clips the panel while it is still rising from below the bottom edge. Without
       it the document grows by the height of a panel that has not arrived yet, and
       the page gets a scrollbar for a fifth of a second. */
    overflow: hidden;
    z-index: 10;
  }
  .overlay[data-full] {
    inset: 0 0 auto 0;
    padding: 0;
  }
  .overlay[data-full] .overlay-panel {
    border-radius: 0;
  }
  .overlay-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-canvas);
    border-radius: 8px;
    box-shadow: var(--shadow-overlay);
    width: min(1400px, 100%);
  }
</style>
