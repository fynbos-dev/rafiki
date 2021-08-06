import PluginHttp from 'ilp-plugin-http'

// Maybe @interledger/pay should export this interface.
export interface IlpPlugin {
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  isConnected: () => boolean
  sendData: (data: Buffer) => Promise<Buffer>
  registerDataHandler: (handler: (data: Buffer) => Promise<Buffer>) => void
  deregisterDataHandler: () => void
}

export function createIlpPlugin(url: string): OutgoingIlpPlugin {
  return new OutgoingIlpPlugin(url)
}

export class OutgoingIlpPlugin extends PluginHttp implements IlpPlugin {
  constructor(url: string) {
    super({
      incoming: {
        // "incoming" is a not actually used. connect() is overridden so that no server is started.
        port: 1234
      },
      outgoing: {
        url
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async connect(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true
  }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  registerDataHandler(_handler: (data: Buffer) => Promise<Buffer>): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  deregisterDataHandler(): void {}
}
