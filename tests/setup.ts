class PointerEventShim extends MouseEvent {
  readonly pointerId: number

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

if (globalThis.PointerEvent === undefined) {
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    value: PointerEventShim,
  })
}
