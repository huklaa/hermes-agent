/**
 * Runtime plugin loader — plugins as CODE, not registry edits, loaded after
 * build time. The pipeline every non-bundled plugin takes:
 *
 *   source (plain ESM js) -> [integrity check] -> bare-specifier rewrite
 *   (`@hermes/plugin-sdk` / `react*` -> live shim blobs, see sdk/runtime.ts)
 *   -> blob `import()` -> validate default HermesPlugin -> register(ctx)
 *
 * Loading the same plugin id again disposes the previous registrations first
 * (agent rewrites a plugin file -> clean reload). Failures toast + log; a
 * broken plugin can never take the app down.
 *
 * Sources today: the in-repo runtime example (`?raw`, proves the pipeline)
 * and the two on-disk doors — `<hermes home>/desktop-plugins/<name>/plugin.js`
 * and the unified agent-plugin half `<hermes home>/plugins/<name>/desktop/
 * plugin.js` — the doors the agent writes through.
 *
 * SECURITY — this is NOT a capability boundary. A loaded plugin is evaluated
 * as ESM in the renderer realm with FULL app authority: the React singleton,
 * the whole SDK (`host.request` gateway RPC, `ctx.rest`, storage, `navigate`).
 * The isolation here is *error* isolation only (ContribBoundary, isolated
 * listeners) — a plugin can't crash the app, but it can do anything the app
 * can. That's acceptable for local sources (disk files can already run code),
 * and `integrity` only proves the bytes match a hash — it does NOT sandbox.
 * A remote source (https + allowlist) must NOT reuse this pipeline as-is:
 * it needs a real boundary (iframe/worker + CSP + capability gating) before
 * it can land. The `{ integrity }` option is the transport seam, not the
 * trust seam.
 */

import { installPluginSdk, sdkImportMap } from '@/sdk/runtime'
import { notifyError } from '@/store/notifications'

import { createPluginContext, type HermesPlugin } from './plugin'
import { $pluginRecords, dropPlugin, pluginActive, type PluginKind, publishPlugin } from './plugins-store'

interface LoadOptions {
  defaultEnabled?: boolean
  file?: string
  integrity?: string
  kind?: PluginKind
}

const loaded = new Map<string, (() => void)[]>()
const importSpecifierRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

function rewriteSpecifiers(source: string): string {
  const map = sdkImportMap()
  return source.replace(importSpecifierRe(), (whole, pre, quote, spec) =>
    map[spec] ? `${pre}${quote}${map[spec]}${quote}` : whole
  )
}

function unsupportedImports(source: string): string[] {
  const map = sdkImportMap()
  const bare = new Set<string>()
  for (const m of source.matchAll(importSpecifierRe())) {
    const spec = m[3]
    if (spec && !/^[./]/.test(spec) && !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !map[spec]) bare.add(spec)
  }
  return [...bare]
}

async function verifyIntegrity(source: string, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split('-', 2)
  if (algo !== 'sha256' || !expected) return false
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const actual = btoa(String.fromCharCode(...new Uint8Array(digest)))
  return actual === expected
}

export function unloadRuntimePlugin(id: string): void {
  loaded.get(id)?.forEach(dispose => dispose())
  loaded.delete(id)
}

export async function loadRuntimePlugin(source: string, origin: string, options: LoadOptions = {}): Promise<null | string> {
  installPluginSdk()
  try {
    if (options.integrity && !(await verifyIntegrity(source, options.integrity))) throw new Error(`integrity check failed for ${origin}`)
    const unsupported = unsupportedImports(source)
    if (unsupported.length > 0) throw new Error(`unsupported import${unsupported.length > 1 ? 's' : ''}: ${unsupported.join(', ')} — runtime plugins may only import @hermes/plugin-sdk and react`)
    const url = URL.createObjectURL(new Blob([rewriteSpecifiers(source)], { type: 'text/javascript' }))
    let mod: { default?: HermesPlugin }
    try { mod = await import(/* @vite-ignore */ url) } finally { URL.revokeObjectURL(url) }
    const plugin = mod.default
    if (!plugin?.id || typeof plugin.register !== 'function') throw new Error(`${origin} has no valid default HermesPlugin export`)
    if ($pluginRecords.get()[plugin.id]?.kind === 'bundled') {
      console.info(`[plugins] ${origin} skipped — "${plugin.id}" already ships bundled with the app`)
      publishPlugin({ id: `${plugin.id}:disk-shadowed`, name: `${plugin.name ?? plugin.id} (stale disk copy)`, description: `Shadowed by the bundled "${plugin.id}" plugin — this folder is no longer used and can be deleted.`, kind: options.kind ?? 'disk', file: options.file, status: 'disabled' })
      return null
    }
    const record = { id: plugin.id, name: plugin.name ?? plugin.id, description: plugin.description, kind: options.kind ?? 'disk', file: options.file }
    const activate = () => {
      unloadRuntimePlugin(plugin.id)
      const disposers: (() => void)[] = []
      plugin.register(createPluginContext(plugin.id, dispose => disposers.push(dispose)))
      loaded.set(plugin.id, disposers)
      publishPlugin({ ...record, status: 'loaded' })
    }
    publishPlugin({ ...record, status: 'disabled' }, { activate, deactivate: () => unloadRuntimePlugin(plugin.id) })
    if (pluginActive(plugin.id, (plugin.defaultEnabled ?? true) && (options.defaultEnabled ?? true))) activate()
    return plugin.id
  } catch (error) {
    console.error(`[plugins] runtime load failed (${origin})`, error)
    notifyError(error, `Plugin "${origin}" failed to load`)
    publishPlugin({ id: origin, name: origin, kind: options.kind ?? 'disk', file: options.file, status: 'error', error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

const DISK_POLL_MS = 5_000
interface DiskRoot { defaultEnabled?: boolean; dir: string; entry: (folderPath: string) => string }
async function diskRoots(): Promise<DiskRoot[]> {
  const desktop = window.hermesDesktop
  if (!desktop) return []
  const roots: DiskRoot[] = []
  const standalone = await desktop.desktopPluginsRoot?.()
  if (standalone) roots.push({ dir: standalone, entry: folder => `${folder}/plugin.js` })
  const unified = await desktop.agentPluginsRoot?.()
  if (unified) roots.push({ defaultEnabled: false, dir: unified, entry: folder => `${folder}/desktop/plugin.js` })
  return roots
}

interface DiskPlugin { defaultEnabled?: boolean; file: string; id: null | string; origin: string; watchId: null | string }
const disk = new Map<string, DiskPlugin>()
let watching = false
let scanning = false

function dropOriginRecord(origin: string, except: DiskPlugin): void {
  for (const other of disk.values()) if (other !== except && other.id === origin) return
  dropPlugin(origin)
}

async function loadDiskPlugin(entry: DiskPlugin): Promise<void> {
  const desktop = window.hermesDesktop!
  const prevId = entry.id
  try {
    const { text } = await desktop.readFileText(entry.file)
    const id = await loadRuntimePlugin(text, entry.origin, { defaultEnabled: entry.defaultEnabled, file: entry.file })
    if (id && prevId && prevId !== id) { unloadRuntimePlugin(prevId); dropPlugin(prevId) }
    entry.id = id ?? entry.id
    if (id && id !== entry.origin) dropOriginRecord(entry.origin, entry)
  } catch { /* File vanished mid-read — next scan reconciles. */ }
}

async function scanDiskPlugins(reloadKnown = false): Promise<void> {
  const desktop = window.hermesDesktop
  if (!desktop || scanning) return
  scanning = true
  try {
    const roots = await diskRoots()
    if (roots.length === 0) return
    const seen = new Set<string>()
    for (const root of roots) {
      let entries
      try { ;({ entries } = await desktop.readDir(root.dir)) } catch { continue }
      for (const dir of entries.filter(e => e.isDirectory)) {
        const file = root.entry(dir.path)
        seen.add(file)
        const known = disk.get(file)
        if (known) {
          if (reloadKnown) await loadDiskPlugin(known)
          continue
        }
        try { await desktop.readFileText(file) } catch { continue }
        const record: DiskPlugin = { defaultEnabled: root.defaultEnabled, file, id: null, origin: dir.name, watchId: null }
        disk.set(file, record)
        await loadDiskPlugin(record)
        try { record.watchId = (await desktop.watchPreviewFile(file)).id } catch { /* manual reload remains available */ }
      }
    }
    for (const [file, record] of disk) {
      if (seen.has(file)) continue
      if (record.id) { unloadRuntimePlugin(record.id); dropPlugin(record.id) }
      dropOriginRecord(record.origin, record)
      if (record.watchId) void desktop.stopPreviewFileWatch(record.watchId)
      disk.delete(file)
    }
  } catch { /* no plugin roots/gateway */ } finally { scanning = false }
}

/** Manual rescan must reread known paths; poll/watch scans only reconcile topology. */
export const discoverRuntimePlugins = () => scanDiskPlugins(true)

export function watchRuntimePlugins(): void {
  const desktop = window.hermesDesktop
  if (watching || !desktop) return
  watching = true
  const dirWatchIds = new Set<string>()
  const watchedDirs = new Set<string>()
  desktop.onPreviewFileChanged(({ id }) => {
    if (dirWatchIds.has(id)) { void scanDiskPlugins(); return }
    for (const entry of disk.values()) if (entry.watchId === id) { void loadDiskPlugin(entry); return }
  })
  const startDirWatches = async () => {
    for (const root of await diskRoots()) {
      if (watchedDirs.has(root.dir)) continue
      try { const { id } = await desktop.watchDirectory(root.dir); watchedDirs.add(root.dir); dirWatchIds.add(id) } catch { /* poll fallback */ }
    }
  }
  void scanDiskPlugins()
  void startDirWatches()
  window.setInterval(() => { if (document.visibilityState === 'visible') { void scanDiskPlugins(); void startDirWatches() } }, DISK_POLL_MS)
}
