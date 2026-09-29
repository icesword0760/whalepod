/** Values replaced by the client bundler before the plugin reaches a browser. */
declare const process: {
  readonly env: {
    readonly DSH_CLIENT_TITLE?: string
    readonly NODE_ENV?: string
  }
}
