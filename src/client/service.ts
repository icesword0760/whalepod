/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`) is **DSH's own `ILayout`, re-exported
 * rather than redefined** — see the type import above.
 *
 * It used to be declared here, listing `toggleSidebar` / `openDetails` /
 * `closeDetails`, which is exactly what official `ui-layout` declared at
 * 0.1.2-alpha.4. 0.1.5 changed the contract to `selectPanel` /
 * `beginNavigation` / `toggleSidebar` / `openRightbar` / `closeRightbar`, and
 * **official plugins call the new members at runtime**:
 * `ui-sidebar` (`src/client/index.ts:67-68`), `ui-workspace`
 * (`src/client/navigation.ts:136,140,149,167`) and `ui-sidebar-right`
 * (`src/client/index.ts:140-141`). This plugin REPLACES `ui-layout`, so it is
 * the one providing `ctx.layout` — a face missing those members is a runtime
 * crash in the official sidebar and workspace navigation, not a type nit.
 *
 * Re-exporting instead of re-declaring also removes the duplicate
 * `Context.layout` augmentation that made TypeScript reject the whole plugin
 * (TS2717): there is now one declaration, owned by DSH.
 */
/**
 * 面板 id 直接从 `ILayout` 的签名里取，而不是单独 import 一个类型名：
 * 这样它永远与 DSH 当下的契约同步，也不依赖那个包是否把这个名字再导出一次
 * （0.1.5 的 `lib/types` 里它就取不到）。
 */
export type MainPanelId = NonNullable<Parameters<ILayout['selectPanel']>[0]>

export type { ILayout }

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #navigation = new AbortController()

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /**
   * Select a global central panel, or return to the workbench.
   *
   * This layout's centre IS the workbench (the card carousel), contributed as
   * the reserved `conversation` key of the `main` slot. A non-null id would
   * name some other keyed `main` entry; nothing in the shipped bundle
   * registers one (`ui-conversation` is the only registrant, at key
   * `conversation`), and this frame has no place to put it — so say so rather
   * than accept the call and silently show the workbench anyway. `null` is the
   * call `ui-workspace`'s navigation actually makes, and it is already true.
   * @param panelId - a registered main key, or null for the workbench.
   */
  selectPanel(panelId: MainPanelId | null): void {
    this.#navigation.abort()
    if (panelId !== null) {
      throw new Error(`layout.selectPanel: this layout has no main panels besides the workbench ("${panelId}")`)
    }
  }

  /**
   * Start an asynchronous navigation, superseding any earlier pending one.
   * Same shape as DSH's own controller (`ui-layout/src/client/service.ts`):
   * one live `AbortController`, aborted by the next navigation.
   * @returns the new pending navigation's cancellation signal.
   */
  beginNavigation(): AbortSignal {
    this.#navigation.abort()
    this.#navigation = new AbortController()
    return this.#navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.#navigation.abort()
  }

  /**
   * Report the right column's presentation.
   *
   * `track` maps onto this frame's right column exactly. **`fullscreen` does
   * not: this layout has no frame-covering overlay mode**, so a fullscreen
   * request opens the column as a normal track. The caller
   * (`ui-sidebar-right`) stays functional — its content is narrower than it
   * asked for, never missing. Recorded here rather than silently dropped so
   * the next author knows it is a deliberate approximation, not an oversight.
   * @param track - whether the column reserves a grid track.
   * @param _fullscreen - accepted for contract compatibility; see above.
   */
  openRightbar(track: boolean, _fullscreen: boolean): void {
    if (track || _fullscreen) this.#require().openDetails()
    else this.#require().closeDetails()
  }

  /** Report the right column as hidden. */
  closeRightbar(): void {
    this.#require().closeDetails()
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
