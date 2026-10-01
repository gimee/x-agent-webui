import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import type { StudioHealthDependencies } from '../contracts/health'

declare const __APP_VERSION__: string

type PackageInfo = {
  name: string
  version: string
}

function readPackageInfo(): PackageInfo | null {
  const candidatePaths = [
    // Dev/test from the repository root.
    resolve(process.cwd(), 'package.json'),
    // Direct TypeScript execution from the migrated Studio module.
    resolve(__dirname, '../../../../../../package.json'),
    // Bundled server: dist/server -> repository/package root.
    resolve(__dirname, '../../package.json'),
  ]

  for (const packagePath of candidatePaths) {
    if (!existsSync(packagePath)) continue
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf-8'))
      if (pkg?.name && pkg?.version) {
        return { name: String(pkg.name), version: String(pkg.version) }
      }
    } catch {
      // Try the next candidate path.
    }
  }
  return null
}


export class StudioHealthService {
  private readonly packageInfo = readPackageInfo()
  private readonly localVersion = typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : this.packageInfo?.version || ''
  private cachedLatestVersion = ''

  constructor(private readonly dependencies: StudioHealthDependencies) {}

  async checkLatestVersion(): Promise<void> {
    // The product deliberately stays on its pinned upstream source. Do not
    // contact npm or any other upstream service for Web UI updates.
    this.cachedLatestVersion = ''
  }

  startVersionCheck(): void {
    // Kept as a no-op compatibility entry point for the bootstrap caller.
  }

  async snapshot() {
    const rawVersion = await this.dependencies.getPrimaryAgentVersion()
    const primaryAgentVersion = rawVersion.split('\n')[0].replace('Hermes Agent ', '') || ''
    const agentBridge = await this.dependencies.getPrimaryAgentBridgeHealth()

    return {
      status: 'ok',
      platform: this.dependencies.platform,
      version: primaryAgentVersion,
      gateway: 'running',
      webui_version: this.localVersion,
      webui_latest: '',
      webui_update_available: false,
      node_version: process.versions.node,
      agent_bridge: agentBridge,
      is_docker: this.dependencies.isDockerContainer(),
    }
  }
}
