import {
  deserializeIlpPrepare,
  isIlpReply,
  serializeIlpReply,
  serializeIlpFulfill
} from 'ilp-packet'
import { serializeIldcpResponse } from 'ilp-protocol-ildcp'
import { StreamServer } from '@interledger/stream-receiver'
import { IlpPlugin } from './ilp_plugin'

export class MockPlugin implements IlpPlugin {
  constructor(private server: StreamServer, private exchangeRate: number) {}
  connect(): Promise<void> {
    return Promise.resolve()
  }
  disconnect(): Promise<void> {
    return Promise.resolve()
  }
  isConnected(): boolean {
    return true
  }

  async sendData(data: Buffer): Promise<Buffer> {
    // First, handle the initial IL-DCP request when the connection is created
    const prepare = deserializeIlpPrepare(data)
    if (prepare.destination === 'peer.config') {
      return serializeIldcpResponse({
        clientAddress: 'test.wallet',
        assetCode: 'XRP',
        assetScale: 9
      })
    } else {
      prepare.amount = Math.floor(
        +prepare.amount * this.exchangeRate
      ).toString()
      const moneyOrReject = this.server.createReply(prepare)
      if (isIlpReply(moneyOrReject)) {
        return serializeIlpReply(moneyOrReject)
      }

      //moneyOrReject.setTotalReceived(prepare.amount)
      return serializeIlpFulfill(moneyOrReject.accept())
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  registerDataHandler(_handler: (data: Buffer) => Promise<Buffer>): void {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  deregisterDataHandler(): void {}
}
