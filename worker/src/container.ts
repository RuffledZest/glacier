import { Container } from '@cloudflare/containers'

export class BuildContainer extends Container {
  defaultPort = 8080
  sleepAfter = '30m'
}
